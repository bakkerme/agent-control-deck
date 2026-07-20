/**
 * NimBLE peripheral — link (S1) + chunked transfer (S2).
 *
 * Double-buffered reassembly: COMMIT copies into a hold buffer so the next
 * BEGIN can start immediately even if the app has not yet taken the payload
 * (e-paper present can block main for seconds).
 *
 * Logs connect state, MTU, bytes, heap — never summary body text.
 */

#include "ble_gatt.h"

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <esp_crc.h>
#include <stdio.h>
#include <string.h>

namespace {

NimBLEServer *g_server = nullptr;
NimBLECharacteristic *g_heartbeat = nullptr;
NimBLECharacteristic *g_info = nullptr;
NimBLECharacteristic *g_ctrl = nullptr;
NimBLECharacteristic *g_data = nullptr;
NimBLECharacteristic *g_state = nullptr;

bool g_started = false;
bool g_heartbeat_subscribed = false;
bool g_state_subscribed = false;
uint16_t g_mtu = 0;
uint32_t g_connect_events = 0;
uint32_t g_disconnect_events = 0;
uint32_t g_hb_seq = 0;
uint32_t g_last_hb_ms = 0;
uint32_t g_last_heap_log_ms = 0;

/* Assembly buffer (active transfer) + hold buffer (committed, for app take). */
uint8_t *g_rx = nullptr;
uint8_t *g_hold = nullptr;
size_t g_rx_cap = 0;
size_t g_rx_len = 0;
size_t g_hold_len = 0;
uint16_t g_expect_seq = 0;
uint16_t g_total_len = 0;
uint32_t g_expect_crc = 0;
uint8_t g_begin_schema = 0;
bool g_xfer_active = false;
bool g_committed_ready = false;
uint32_t g_xfer_ok_count = 0;
uint32_t g_xfer_fail_count = 0;
uint32_t g_busy_count = 0;
uint32_t g_drop_hold_count = 0;

char g_device_name[16] = BLE_DEVICE_NAME_PREFIX "????";

void build_device_name(void)
{
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_BT) != ESP_OK) {
        if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) {
            snprintf(g_device_name, sizeof(g_device_name), "%s0000", BLE_DEVICE_NAME_PREFIX);
            return;
        }
    }
    snprintf(g_device_name, sizeof(g_device_name), "%s%02X%02X", BLE_DEVICE_NAME_PREFIX, mac[4],
             mac[5]);
}

void log_heap(const char *tag)
{
    Serial.printf("[ble] %s free_heap=%u min_free_heap=%u\n", tag,
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap());
}

void update_info_value(void)
{
    if (!g_info) {
        return;
    }
    char buf[96];
    snprintf(buf, sizeof(buf), "fw=%s max_payload=%u preferred_mtu=247 name=%s", BLE_FW_VERSION,
             (unsigned)BLE_MAX_PAYLOAD_BYTES, g_device_name);
    g_info->setValue((uint8_t *)buf, strlen(buf));
}

void notify_state(const char *msg)
{
    if (!g_state || !msg) {
        return;
    }
    g_state->setValue(msg);
    /* Always attempt notify when a peer is connected; CCCD may lag setValue. */
    if (g_server && g_server->getConnectedCount() > 0) {
        g_state->notify();
    }
    Serial.printf("[ble] STATE %s\n", msg);
}

void reset_transfer(void)
{
    g_xfer_active = false;
    g_rx_len = 0;
    g_expect_seq = 0;
    g_total_len = 0;
    g_expect_crc = 0;
    g_begin_schema = 0;
}

void abort_transfer(const char *reason)
{
    reset_transfer();
    notify_state(reason ? reason : "abort");
}

uint16_t rd_u16_le(const uint8_t *p)
{
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

uint32_t rd_u32_le(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

void handle_ctrl(const uint8_t *data, size_t len)
{
    if (!data || len < 1) {
        return;
    }
    const uint8_t op = data[0];

    if (op == BLE_CTRL_ABORT) {
        if (g_xfer_active) {
            g_xfer_fail_count++;
            abort_transfer("abort");
        }
        return;
    }

    if (op == BLE_CTRL_BEGIN) {
        if (len < BLE_CTRL_BEGIN_LEN) {
            notify_state("bad_len");
            g_xfer_fail_count++;
            return;
        }
        if (g_xfer_active) {
            /* True busy: mid-transfer only. Committed-but-unread uses hold buf. */
            g_busy_count++;
            g_xfer_fail_count++;
            notify_state("busy");
            return;
        }
        if (!g_rx || !g_hold) {
            notify_state("overflow");
            g_xfer_fail_count++;
            return;
        }

        g_begin_schema = data[1];
        g_total_len = rd_u16_le(data + 2);
        g_expect_crc = rd_u32_le(data + 4);

        if (g_total_len == 0 || g_total_len > g_rx_cap) {
            notify_state("overflow");
            g_xfer_fail_count++;
            return;
        }

        g_xfer_active = true;
        g_rx_len = 0;
        g_expect_seq = 0;
        /* Avoid serial spam during 100x soak — log every 25th BEGIN. */
        if ((g_xfer_ok_count + g_xfer_fail_count) % 25 == 0) {
            Serial.printf("[ble] BEGIN schema=%u total_len=%u crc=0x%08x\n",
                          (unsigned)g_begin_schema, (unsigned)g_total_len,
                          (unsigned)g_expect_crc);
        }
        return;
    }

    if (op == BLE_CTRL_COMMIT) {
        if (!g_xfer_active) {
            notify_state("incomplete");
            g_xfer_fail_count++;
            return;
        }
        if (g_begin_schema != 1) {
            reset_transfer();
            notify_state("schema");
            /* Not a transport fail for S2 CRC path, but host may count separately. */
            return;
        }
        if (g_rx_len != g_total_len) {
            Serial.printf("[ble] COMMIT len mismatch got=%u expect=%u\n", (unsigned)g_rx_len,
                          (unsigned)g_total_len);
            reset_transfer();
            notify_state("incomplete");
            g_xfer_fail_count++;
            return;
        }
        const uint32_t crc = esp_crc32_le(0, g_rx, g_rx_len);
        if (crc != g_expect_crc) {
            Serial.printf("[ble] COMMIT bad_crc got=0x%08x expect=0x%08x\n", (unsigned)crc,
                          (unsigned)g_expect_crc);
            reset_transfer();
            notify_state("bad_crc");
            g_xfer_fail_count++;
            return;
        }

        /* Copy to hold so rx is free for the next BEGIN immediately. */
        if (g_committed_ready) {
            g_drop_hold_count++;
        }
        memcpy(g_hold, g_rx, g_rx_len);
        g_hold_len = g_rx_len;
        g_committed_ready = true;

        reset_transfer();
        g_xfer_ok_count++;
        if (g_xfer_ok_count <= 3 || g_xfer_ok_count % 25 == 0) {
            Serial.printf("[ble] COMMIT ok bytes=%u ok_n=%u fail_n=%u busy_n=%u drop_hold=%u heap=%u\n",
                          (unsigned)g_hold_len, (unsigned)g_xfer_ok_count,
                          (unsigned)g_xfer_fail_count, (unsigned)g_busy_count,
                          (unsigned)g_drop_hold_count, (unsigned)ESP.getFreeHeap());
        }
        notify_state("ok");
        return;
    }

    notify_state("bad_len");
    g_xfer_fail_count++;
}

void handle_data(const uint8_t *data, size_t len)
{
    if (!g_xfer_active || !g_rx) {
        return;
    }
    if (len < 2) {
        g_xfer_fail_count++;
        abort_transfer("bad_len");
        return;
    }
    const uint16_t seq = rd_u16_le(data);
    if (seq != g_expect_seq) {
        Serial.printf("[ble] DATA seq got=%u expect=%u\n", (unsigned)seq, (unsigned)g_expect_seq);
        g_xfer_fail_count++;
        abort_transfer("incomplete");
        return;
    }
    const size_t chunk = len - 2;
    if (g_rx_len + chunk > g_total_len || g_rx_len + chunk > g_rx_cap) {
        g_xfer_fail_count++;
        abort_transfer("overflow");
        return;
    }
    memcpy(g_rx + g_rx_len, data + 2, chunk);
    g_rx_len += chunk;
    g_expect_seq++;
}

class ServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer *server, NimBLEConnInfo &connInfo) override
    {
        (void)server;
        g_connect_events++;
        g_mtu = connInfo.getMTU();
        Serial.printf("[ble] connect handle=%u addr=%s mtu=%u events_c=%u\n",
                      connInfo.getConnHandle(), connInfo.getAddress().toString().c_str(),
                      (unsigned)g_mtu, (unsigned)g_connect_events);
        log_heap("on_connect");
        if (g_server) {
            /* Slightly snappier intervals for bulk write soak; still e-paper friendly. */
            g_server->updateConnParams(connInfo.getConnHandle(), 12, 24, 0, 400);
        }
    }

    void onDisconnect(NimBLEServer *server, NimBLEConnInfo &connInfo, int reason) override
    {
        (void)server;
        g_disconnect_events++;
        g_heartbeat_subscribed = false;
        g_state_subscribed = false;
        g_mtu = 0;
        if (g_xfer_active) {
            reset_transfer();
            g_xfer_fail_count++;
        }
        Serial.printf("[ble] disconnect handle=%u reason=%d events_d=%u — restart adv\n",
                      connInfo.getConnHandle(), reason, (unsigned)g_disconnect_events);
        log_heap("on_disconnect");
        NimBLEDevice::startAdvertising();
    }

    void onMTUChange(uint16_t MTU, NimBLEConnInfo &connInfo) override
    {
        g_mtu = MTU;
        Serial.printf("[ble] mtu_change mtu=%u handle=%u\n", (unsigned)MTU,
                      connInfo.getConnHandle());
    }
} g_server_callbacks;

class HeartbeatCallbacks : public NimBLECharacteristicCallbacks {
    void onSubscribe(NimBLECharacteristic *characteristic, NimBLEConnInfo &connInfo,
                     uint16_t subValue) override
    {
        (void)characteristic;
        g_heartbeat_subscribed = (subValue & 0x1) != 0;
        Serial.printf("[ble] heartbeat subscribe=%u handle=%u\n", (unsigned)subValue,
                      connInfo.getConnHandle());
    }
} g_heartbeat_callbacks;

class StateCallbacks : public NimBLECharacteristicCallbacks {
    void onSubscribe(NimBLECharacteristic *characteristic, NimBLEConnInfo &connInfo,
                     uint16_t subValue) override
    {
        (void)characteristic;
        g_state_subscribed = (subValue & 0x1) != 0;
        Serial.printf("[ble] state subscribe=%u handle=%u\n", (unsigned)subValue,
                      connInfo.getConnHandle());
    }
} g_state_callbacks;

class CtrlCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic *characteristic, NimBLEConnInfo &connInfo) override
    {
        (void)connInfo;
        NimBLEAttValue v = characteristic->getValue();
        handle_ctrl(v.data(), v.size());
    }
} g_ctrl_callbacks;

class DataCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic *characteristic, NimBLEConnInfo &connInfo) override
    {
        (void)connInfo;
        NimBLEAttValue v = characteristic->getValue();
        handle_data(v.data(), v.size());
    }
} g_data_callbacks;

uint8_t *alloc_buf(size_t n)
{
    uint8_t *p = (uint8_t *)ps_malloc(n);
    if (!p) {
        p = (uint8_t *)malloc(n);
    }
    return p;
}

} // namespace

bool ble_gatt_begin(void)
{
    if (g_started) {
        return true;
    }

    g_rx_cap = BLE_MAX_PAYLOAD_BYTES;
    g_rx = alloc_buf(g_rx_cap);
    g_hold = alloc_buf(g_rx_cap);
    if (!g_rx || !g_hold) {
        Serial.println("[ble] rx/hold buffer alloc failed");
        return false;
    }
    Serial.printf("[ble] rx+hold buffers %u bytes each\n", (unsigned)g_rx_cap);

    build_device_name();
    Serial.printf("[ble] init name=%s service=%s\n", g_device_name, BLE_UUID_STATUS_SERVICE);
    log_heap("pre_nimble");

    NimBLEDevice::init(g_device_name);
    NimBLEDevice::setSecurityAuth(false, false, false);
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);
    NimBLEDevice::setMTU(247);

    g_server = NimBLEDevice::createServer();
    if (!g_server) {
        Serial.println("[ble] createServer failed");
        return false;
    }
    g_server->setCallbacks(&g_server_callbacks);

    NimBLEService *svc = g_server->createService(BLE_UUID_STATUS_SERVICE);
    if (!svc) {
        Serial.println("[ble] createService failed");
        return false;
    }

    const uint16_t kChrMax = 512;

    g_heartbeat = svc->createCharacteristic(BLE_UUID_HEARTBEAT,
                                            NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY, kChrMax);
    if (!g_heartbeat) {
        return false;
    }
    g_heartbeat->setCallbacks(&g_heartbeat_callbacks);
    g_heartbeat->setValue("hb=0");

    g_info = svc->createCharacteristic(BLE_UUID_INFO, NIMBLE_PROPERTY::READ, kChrMax);
    if (!g_info) {
        return false;
    }
    update_info_value();

    g_ctrl = svc->createCharacteristic(BLE_UUID_STATUS_CTRL, NIMBLE_PROPERTY::WRITE, kChrMax);
    if (!g_ctrl) {
        return false;
    }
    g_ctrl->setCallbacks(&g_ctrl_callbacks);

    g_data = svc->createCharacteristic(
        BLE_UUID_STATUS_DATA, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR, kChrMax);
    if (!g_data) {
        return false;
    }
    g_data->setCallbacks(&g_data_callbacks);

    g_state = svc->createCharacteristic(BLE_UUID_STATUS_STATE,
                                        NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY, kChrMax);
    if (!g_state) {
        return false;
    }
    g_state->setCallbacks(&g_state_callbacks);
    g_state->setValue("idle");

    NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
    adv->setName(g_device_name);
    adv->addServiceUUID(BLE_UUID_STATUS_SERVICE);
    adv->enableScanResponse(true);
    adv->start();

    g_started = true;
    g_last_hb_ms = millis();
    g_last_heap_log_ms = millis();
    Serial.printf("[ble] advertising as %s\n", g_device_name);
    log_heap("post_adv");
    return true;
}

bool ble_gatt_is_connected(void)
{
    return g_server && g_server->getConnectedCount() > 0;
}

uint8_t ble_gatt_connected_count(void)
{
    if (!g_server) {
        return 0;
    }
    return (uint8_t)g_server->getConnectedCount();
}

uint16_t ble_gatt_mtu(void)
{
    return g_mtu;
}

uint32_t ble_gatt_connect_events(void)
{
    return g_connect_events;
}

uint32_t ble_gatt_disconnect_events(void)
{
    return g_disconnect_events;
}

bool ble_gatt_take_committed(const uint8_t **data, size_t *len)
{
    if (!g_committed_ready || !g_hold || !data || !len) {
        return false;
    }
    *data = g_hold;
    *len = g_hold_len;
    g_committed_ready = false;
    return true;
}

bool ble_gatt_transfer_active(void)
{
    return g_xfer_active;
}

void ble_gatt_poll(void)
{
    if (!g_started) {
        return;
    }

    const uint32_t now = millis();

    /* Suppress heartbeat notify while a transfer is active — reduce radio contention. */
    if (g_server && g_server->getConnectedCount() > 0 && g_heartbeat_subscribed && g_heartbeat &&
        !g_xfer_active) {
        if ((uint32_t)(now - g_last_hb_ms) >= BLE_HEARTBEAT_INTERVAL_MS) {
            g_last_hb_ms = now;
            g_hb_seq++;
            char buf[96];
            snprintf(buf, sizeof(buf), "hb=%u up_ms=%u heap=%u mtu=%u ok=%u fail=%u busy=%u",
                     (unsigned)g_hb_seq, (unsigned)now, (unsigned)ESP.getFreeHeap(),
                     (unsigned)g_mtu, (unsigned)g_xfer_ok_count, (unsigned)g_xfer_fail_count,
                     (unsigned)g_busy_count);
            g_heartbeat->setValue((uint8_t *)buf, strlen(buf));
            g_heartbeat->notify();
        }
    }

    if ((uint32_t)(now - g_last_heap_log_ms) >= BLE_HEAP_LOG_INTERVAL_MS) {
        g_last_heap_log_ms = now;
        Serial.printf(
            "[ble] soak connected=%u mtu=%u c=%u d=%u xfer_ok=%u xfer_fail=%u busy=%u drop_hold=%u ",
            (unsigned)ble_gatt_connected_count(), (unsigned)g_mtu, (unsigned)g_connect_events,
            (unsigned)g_disconnect_events, (unsigned)g_xfer_ok_count, (unsigned)g_xfer_fail_count,
            (unsigned)g_busy_count, (unsigned)g_drop_hold_count);
        log_heap("periodic");
    }
}
