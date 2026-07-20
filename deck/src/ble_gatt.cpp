/**
 * NimBLE peripheral — PR-S1 link spike.
 *
 * Logs connect state, MTU, heap — never summary body text (none yet).
 */

#include "ble_gatt.h"

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <stdio.h>
#include <string.h>

namespace {

NimBLEServer *g_server = nullptr;
NimBLECharacteristic *g_heartbeat = nullptr;
NimBLECharacteristic *g_info = nullptr;

bool g_started = false;
bool g_heartbeat_subscribed = false;
uint16_t g_mtu = 0;
uint32_t g_connect_events = 0;
uint32_t g_disconnect_events = 0;
uint32_t g_hb_seq = 0;
uint32_t g_last_hb_ms = 0;
uint32_t g_last_heap_log_ms = 0;

char g_device_name[16] = BLE_DEVICE_NAME_PREFIX "????";

void build_device_name(void)
{
    uint8_t mac[6] = {0};
    /* Public address used for identity; last 2 bytes → 4 hex chars. */
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
    /* Compact ASCII, no secrets. max_payload matches StatusSnapshot budget. */
    char buf[96];
    snprintf(buf, sizeof(buf), "fw=%s max_payload=%u preferred_mtu=247 name=%s", BLE_FW_VERSION,
             (unsigned)BLE_MAX_PAYLOAD_BYTES, g_device_name);
    g_info->setValue((uint8_t *)buf, strlen(buf));
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
        /* Prefer slightly longer intervals for e-paper idle link stability. */
        if (g_server) {
            g_server->updateConnParams(connInfo.getConnHandle(), 24, 48, 0, 400);
        }
    }

    void onDisconnect(NimBLEServer *server, NimBLEConnInfo &connInfo, int reason) override
    {
        (void)server;
        g_disconnect_events++;
        g_heartbeat_subscribed = false;
        g_mtu = 0;
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

} // namespace

bool ble_gatt_begin(void)
{
    if (g_started) {
        return true;
    }

    build_device_name();
    Serial.printf("[ble] init name=%s service=%s\n", g_device_name, BLE_UUID_STATUS_SERVICE);
    log_heap("pre_nimble");

    NimBLEDevice::init(g_device_name);
    /* Spike: open lab link — no bonding / MITM (S4+ may tighten). */
    NimBLEDevice::setSecurityAuth(false, false, false);
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);

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

    g_heartbeat = svc->createCharacteristic(BLE_UUID_HEARTBEAT, NIMBLE_PROPERTY::READ |
                                                                    NIMBLE_PROPERTY::NOTIFY);
    if (!g_heartbeat) {
        Serial.println("[ble] create HEARTBEAT failed");
        return false;
    }
    g_heartbeat->setCallbacks(&g_heartbeat_callbacks);
    g_heartbeat->setValue("hb=0");

    g_info = svc->createCharacteristic(BLE_UUID_INFO, NIMBLE_PROPERTY::READ);
    if (!g_info) {
        Serial.println("[ble] create INFO failed");
        return false;
    }
    update_info_value();
    /* NimBLE 2.x starts services when advertising/server starts. */

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

void ble_gatt_poll(void)
{
    if (!g_started) {
        return;
    }

    const uint32_t now = millis();

    if (g_server && g_server->getConnectedCount() > 0 && g_heartbeat_subscribed && g_heartbeat) {
        if ((uint32_t)(now - g_last_hb_ms) >= BLE_HEARTBEAT_INTERVAL_MS) {
            g_last_hb_ms = now;
            g_hb_seq++;
            char buf[64];
            snprintf(buf, sizeof(buf), "hb=%u up_ms=%u heap=%u mtu=%u", (unsigned)g_hb_seq,
                     (unsigned)now, (unsigned)ESP.getFreeHeap(), (unsigned)g_mtu);
            g_heartbeat->setValue((uint8_t *)buf, strlen(buf));
            g_heartbeat->notify();
            Serial.printf("[ble] notify %s\n", buf);
        }
    }

    if ((uint32_t)(now - g_last_heap_log_ms) >= BLE_HEAP_LOG_INTERVAL_MS) {
        g_last_heap_log_ms = now;
        Serial.printf("[ble] soak connected=%u mtu=%u c=%u d=%u ",
                      (unsigned)ble_gatt_connected_count(), (unsigned)g_mtu,
                      (unsigned)g_connect_events, (unsigned)g_disconnect_events);
        log_heap("periodic");
    }
}
