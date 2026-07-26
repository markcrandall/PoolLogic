"""Status LED support for the bridge host (Raspberry Pi).

Drives either the Pi's onboard ACT LED (sysfs, no extra hardware) or external
GPIO LED(s) (requires the soldered header and gpiozero). On machines with
neither (e.g. the Windows dev box), resolves to a no-op.

Patterns (single LED):
    rapid blink   starting / first connect not yet succeeded
    heartbeat     bridge up, pool link OK (short flash every 3s)
    steady blink  pool unreachable (1s cycle)
    dark          bridge not running

Dual-LED GPIO mode (okPin + downPin): green heartbeats when OK, red is solid
when the pool link is down.

config.json:
    "statusLed": { "mode": "auto" }                          # act if present
    "statusLed": { "mode": "act" }
    "statusLed": { "mode": "gpio", "pin": 17 }               # single LED
    "statusLed": { "mode": "gpio", "okPin": 17, "downPin": 27 }
    "statusLed": { "mode": "off" }
"""

import asyncio
import os
from contextlib import suppress

ACT_LED_PATHS = ("/sys/class/leds/ACT", "/sys/class/leds/led0")

HEARTBEAT_PERIOD = 3.0
HEARTBEAT_FLASH = 0.12
DOWN_BLINK = 0.5
STARTING_BLINK = 0.15


class NullLed:
    def set(self, on):
        pass

    def close(self):
        pass


class ActLed:
    """Onboard activity LED via sysfs. Needs write access to /sys/class/leds
    (run the service as root, or chown the files with a udev rule)."""

    def __init__(self, path):
        self.path = path
        self._write("trigger", "none")

    def _write(self, name, value):
        with open(os.path.join(self.path, name), "w") as f:
            f.write(str(value))

    def set(self, on):
        self._write("brightness", 1 if on else 0)

    def close(self):
        self._write("trigger", "mmc0")


class GpioLed:
    def __init__(self, pin):
        from gpiozero import LED  # present on Raspberry Pi OS

        self.led = LED(pin)

    def set(self, on):
        if on:
            self.led.on()
        else:
            self.led.off()

    def close(self):
        self.led.close()


def _make_single(cfg):
    mode = cfg.get("mode", "auto")
    if mode == "off":
        return NullLed(), None
    if mode in ("auto", "act"):
        for path in ACT_LED_PATHS:
            if os.path.isdir(path):
                try:
                    return ActLed(path), None
                except OSError as ex:
                    print(f"status LED: ACT unavailable ({ex}); disabled")
                    return NullLed(), None
        if mode == "act":
            print("status LED: no ACT LED found; disabled")
        return NullLed(), None
    if mode == "gpio":
        try:
            if "okPin" in cfg and "downPin" in cfg:
                return GpioLed(cfg["okPin"]), GpioLed(cfg["downPin"])
            return GpioLed(cfg["pin"]), None
        except Exception as ex:
            print(f"status LED: gpio unavailable ({ex}); disabled")
            return NullLed(), None
    print(f"status LED: unknown mode {mode!r}; disabled")
    return NullLed(), None


class StatusLedTask:
    """Async pattern driver. Reads the backend's pool_up flag each cycle."""

    def __init__(self, config, get_pool_up):
        cfg = config.get("statusLed", {})
        self.ok_led, self.down_led = _make_single(cfg)
        self.get_pool_up = get_pool_up
        self._ever_ok = False
        self._task = None

    def start(self):
        if isinstance(self.ok_led, NullLed) and self.down_led is None:
            return  # nothing to drive
        self._task = asyncio.get_event_loop().create_task(self._run())

    async def stop(self):
        """Hand the ACT LED back to its normal trigger.

        _run's finally already does this when the task is cancelled during
        loop teardown, but only if cancellation happens to be awaited. Doing it
        explicitly means a stopped bridge always leaves a dark LED under the
        mmc0 trigger — matching the documented "dark = not running" — instead
        of occasionally freezing mid-flash with the LED stuck on.
        """
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task  # _run's finally closes both LEDs
            self._task = None
            return
        for led in (self.ok_led, self.down_led):
            if led is not None:
                with suppress(Exception):
                    led.close()

    async def _run(self):
        try:
            while True:
                up = bool(self.get_pool_up())
                if up:
                    self._ever_ok = True

                if self.down_led is not None:
                    # Dual-LED: green heartbeat / solid red
                    self.down_led.set(not up)
                    if up:
                        await self._flash(self.ok_led, HEARTBEAT_FLASH)
                        await asyncio.sleep(HEARTBEAT_PERIOD - HEARTBEAT_FLASH)
                    else:
                        self.ok_led.set(False)
                        await asyncio.sleep(0.5)
                elif up:
                    await self._flash(self.ok_led, HEARTBEAT_FLASH)
                    await asyncio.sleep(HEARTBEAT_PERIOD - HEARTBEAT_FLASH)
                elif not self._ever_ok:
                    await self._flash(self.ok_led, STARTING_BLINK)
                    await asyncio.sleep(STARTING_BLINK)
                else:
                    await self._flash(self.ok_led, DOWN_BLINK)
                    await asyncio.sleep(DOWN_BLINK)
        finally:
            # Never let a failed sysfs write during shutdown escape a cancelled
            # task and surface as a cleanup error.
            for led in (self.ok_led, self.down_led):
                if led is not None:
                    with suppress(Exception):
                        led.close()

    async def _flash(self, led, seconds):
        led.set(True)
        await asyncio.sleep(seconds)
        led.set(False)
