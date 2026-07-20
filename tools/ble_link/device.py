"""Scan helpers for ACD-* decks."""

from __future__ import annotations

from bleak import BleakScanner

from protocol import NAME_PREFIX, UUID_STATUS_SERVICE


async def find_device(timeout: float, name: str | None, address: str | None):
    if address:
        return address

    devices = await BleakScanner.discover(timeout=timeout)
    matches = []
    for d in devices:
        dname = d.name or ""
        if name and dname == name:
            matches.append(d)
        elif not name and dname.startswith(NAME_PREFIX):
            matches.append(d)

    if not matches:
        for d in devices:
            ad = getattr(d, "metadata", {}) or {}
            uuids = [u.lower() for u in (ad.get("uuids") or [])]
            if UUID_STATUS_SERVICE.lower() in uuids:
                matches.append(d)

    if not matches:
        return None, devices
    return matches[0], devices
