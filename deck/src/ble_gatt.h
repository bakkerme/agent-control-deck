/**
 * BLE GATT peripheral — spike S1–S4.
 *
 * S1: advertise, one central, HEARTBEAT notify, INFO read.
 * S2: STATUS_CTRL / STATUS_DATA reassembly (≤ 8 KiB) + CRC32 + STATUS_STATE notify.
 * S3/S4: main consumes committed payload (parse / STALE).
 *
 * Wi‑Fi must remain off for the spike (caller responsibility).
 */

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Device name prefix; full name is "ACD-" + last 4 hex of public MAC. */
#define BLE_DEVICE_NAME_PREFIX "ACD-"

/**
 * Spike UUIDs (128-bit). Base: a0cd****-acd0-4c00-9c00-00805f9b34fb
 */
#define BLE_UUID_STATUS_SERVICE "a0cd0001-acd0-4c00-9c00-00805f9b34fb"
#define BLE_UUID_HEARTBEAT      "a0cd0002-acd0-4c00-9c00-00805f9b34fb"
#define BLE_UUID_INFO           "a0cd0003-acd0-4c00-9c00-00805f9b34fb"
#define BLE_UUID_STATUS_CTRL    "a0cd0010-acd0-4c00-9c00-00805f9b34fb"
#define BLE_UUID_STATUS_DATA    "a0cd0011-acd0-4c00-9c00-00805f9b34fb"
#define BLE_UUID_STATUS_STATE   "a0cd0012-acd0-4c00-9c00-00805f9b34fb"

#define BLE_FW_VERSION            "0.1.0-s4"
#define BLE_MAX_PAYLOAD_BYTES     8192
#define BLE_HEARTBEAT_INTERVAL_MS 5000
#define BLE_HEAP_LOG_INTERVAL_MS  30000

/** CTRL opcodes (first byte of STATUS_CTRL write). */
#define BLE_CTRL_BEGIN  0x01
#define BLE_CTRL_ABORT  0x02
#define BLE_CTRL_COMMIT 0x03

/** BEGIN payload after opcode: schema_version u8, total_len u16 LE, crc32 u32 LE. */
#define BLE_CTRL_BEGIN_LEN 8

/** Initialize NimBLE stack, GATT, and start advertising. Returns false on init failure. */
bool ble_gatt_begin(void);

/** True while a central is connected. */
bool ble_gatt_is_connected(void);

/** Connection count (0 or 1 for this spike). */
uint8_t ble_gatt_connected_count(void);

/** Negotiated ATT MTU for the active connection (0 if none). */
uint16_t ble_gatt_mtu(void);

/** Cumulative connect / disconnect events since boot (for soak logs). */
uint32_t ble_gatt_connect_events(void);
uint32_t ble_gatt_disconnect_events(void);

/**
 * If a COMMIT just completed with CRC/len OK, copy pointers to the reassembled
 * payload (valid until the next BEGIN or take). Returns true once per commit.
 */
bool ble_gatt_take_committed(const uint8_t **data, size_t *len);

/** True when a transfer is mid-flight (BEGIN received, not yet COMMIT/ABORT). */
bool ble_gatt_transfer_active(void);

/**
 * Periodic work: heartbeat notify when subscribed + serial diagnostics.
 * Call from loop().
 */
void ble_gatt_poll(void);

#ifdef __cplusplus
}
#endif
