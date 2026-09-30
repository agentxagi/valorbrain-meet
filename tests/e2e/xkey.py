"""Real X11 key press (XTest) for the end-to-end run: Chrome only lets an
extension capture a tab after the user invokes it, and a keyboard shortcut
coming from the X server is the same thing a person pressing it produces.

Usage: python xkey.py Alt_L+Shift_L+g   (DISPLAY must point at the Xvfb server)
Needs python-xlib (pip install python-xlib==0.33).
"""

import sys
import time

from Xlib import X, XK, display
from Xlib.ext import xtest


def main() -> None:
    combo = sys.argv[1].split("+")
    d = display.Display()
    root = d.screen().root
    # Without a window manager, focus follows the pointer: park it on Chrome.
    xtest.fake_input(d, X.MotionNotify, x=200, y=200, root=root)
    d.sync()
    time.sleep(0.1)
    codes = [d.keysym_to_keycode(XK.string_to_keysym(key)) for key in combo]
    for code in codes:
        xtest.fake_input(d, X.KeyPress, code)
        d.sync()
        time.sleep(0.05)
    for code in reversed(codes):
        xtest.fake_input(d, X.KeyRelease, code)
        d.sync()
        time.sleep(0.05)
    d.close()


if __name__ == "__main__":
    main()
