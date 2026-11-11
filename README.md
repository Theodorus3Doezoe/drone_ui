# Laptop ground-station: React-frontend + Node-backend voor ELRS-bridge en FC-tuning

Eén web-app die twee dingen doet:
1. **RC-bridge:** USB-controller uitlezen en als CRSF-frames (±150Hz) via USB-serieel
   naar een LilyGO TTGO LoRa32 sturen die als ExpressLRS-900-TX firmware draait.
2. **FC-tuning:** via een tweede USB-serieel (RP2350 USB-CDC) postcard-commando's
   sturen (live PID-tuning) en telemetrie visualiseren.

ELRS-config (binding phrase, EU868-domein, pinmapping) gebeurt NIET hier — dat is
bij het flashen via ExpressLRS Configurator al gedaan.

## Layout

- `shared/` — kanaallayout-contract, CRSF encode/decode + CRC8-DVB-S2, postcard-codec
  (spiegelt `rust_fc/tools/postcard_codec.py`), websocket-protocoltypes.
- `backend/` — Node + TypeScript, `serialport` voor beide USB-poorten, `ws` als enige
  frontend-koppeling, `node-hid` (optioneel) als fallback.
- `frontend/` — React + Vite + TypeScript, géén WebSerial; alle hardware via backend.

## Kanaallayout (contract met `rust_fc/src/receiver/crsf.rs`)

ch1=roll, ch2=pitch, ch3=throttle, ch4=yaw (AETR), ch5=mode (SA),
ch9=arm (SE, >1500=armed). Overig op midden (992). Waarden 172–1811.

## Draaien

```bash
npm install          # eenmalig
npm run dev          # bouwt shared+backend, start bridge én dashboard, opent de browser
# extra bridge-opties: npm run dev -- --tx-port /dev/ttyUSB0 --fc-port /dev/ttyACM0
# zonder browser:      npm run dev -- --no-open
```

Losse onderdelen (indien nodig):

```bash
npm run build         # alles compileren
npm run bridge        # alleen backend (auto-detecteert TX (CP210x/CH340) en FC (RP2350))
# expliciet mag altijd: --tx-port /dev/ttyUSB0 --fc-port /dev/ttyACM0
# overig: --tx-baud 420000 --fc-baud 115200 --ws-port 8080
# TX-baud staat standaard op 921600 en is live om te zetten in het dashboard
# (presets 921600/420000 of een eigen waarde; de poort heropent automatisch).
# bekijk kandidaten: npm run bridge -- --list-ports
# Headless HID-joystick: --hid (auto) of --hid=/dev/hidraw0 (Xbox via frontend!)
cd frontend && npm run dev   # UI los, verbindt op ws://<host>:8080
```

## Xbox-controller

- **Aanbevolen: via de frontend.** Browsers normaliseren Xbox-pads (360/One/Series,
  USB én Bluetooth) via de Gamepad-API (`standard`-mapping). Xbox-pads zijn over
  USB meestal géén HID maar XInput — daarom loopt dit pad via de browser, niet
  via `node-hid`.
- Throttle-presets in de UI: **Mode 2** (links: yaw+throttle, rechts: roll+pitch,
  EdgeTX-conventie) of **Triggers** (RT−LT = throttle). Expo- en
  deadband-schuiven, live knopweergave (A/B/X/Y, LB/RB, LT/RT, Back/Start) en een
  knop-legenda zijn ingebouwd.
- Veiligheid: **LB indrukken = arm-toggle**, Start = arm-latch,
  Back = latch uit, RB = Rate-mode-toggle. Zonder pad stuurt de UI niets en grijpt de
  backend-failsafe in (geen verse input → stop met zenden).
- **ELRS-heartbeat:** zodra de TX-poort open is stuurt de backend 1× per seconde
  een ping (`0x7A`/`0x7F03`, seq+tijd+random) via de TX-module; de FC echoot via
  `0x7B`/`0x7F03` en het dashboard toont de RTT. TunAck (`0x7B`/`0x7F04`,
  postcard) markeert tuning live en toont de toegepaste waarden.
- **Headless** (`--hid`): voor echte USB-HID-joysticks (Boxer e.d.); XInput-rapporten
  (xpad-driver) worden herkend, anders generieke 8-bit HID-assen.

Failsafe: bij HID- of serieel-verlies stopt de backend direct met zenden
(RX-timeout op de FC). Geen auto-reconnect-spam: 1× rode banner + handmatige
reconnect-knop.
