import pathlib
import runpy
import sys
import types
import unittest
from unittest.mock import patch


class FakeIcon:
    def __init__(self, position, name, index, sprite):
        assert 0 <= index < 6
        assert position[1] <= 90
        self.name = name

    def activate(self, active):
        self.active = active

    def draw(self):
        pass


class MenuTest(unittest.TestCase):
    def setUp(self):
        self.io = types.SimpleNamespace(
            pressed=[], BUTTON_A="A", BUTTON_B="B", BUTTON_C="C",
            BUTTON_UP="UP", BUTTON_DOWN="DOWN",
        )
        screen = types.SimpleNamespace(
            clear=lambda: None, text=lambda *args: None,
            measure_text=lambda text: (len(text) * 5, 8),
        )
        folders = ["quest", "monapet", "sketch", "flappy", "gallery", "badge", "underhive"]

        def exists(filename):
            return filename.split("/")[3] in folders

        badgeware = types.SimpleNamespace(
            screen=screen, PixelFont=types.SimpleNamespace(load=lambda _: None),
            Image=types.SimpleNamespace(load=lambda _: object()),
            is_dir=lambda _: True, file_exists=exists,
            brushes=types.SimpleNamespace(color=lambda *args: args), io=self.io,
            run=lambda update: None,
        )
        previous_path = sys.path[:]
        try:
            with patch.dict(sys.modules, {
                "badgeware": badgeware,
                "icon": types.SimpleNamespace(Icon=FakeIcon),
                "ui": types.SimpleNamespace(draw_background=lambda: None, draw_header=lambda: None),
            }), patch("os.chdir"), patch("os.listdir", return_value=folders):
                loaded = runpy.run_path(str(pathlib.Path(__file__).with_name("menu.py")))
                self.menu = loaded["update"].__globals__
        finally:
            sys.path[:] = previous_path

    def press(self, button):
        self.io.pressed = [button]
        return self.menu["update"]()

    def test_original_apps_remain_first_and_billboard_has_a_second_page(self):
        self.assertEqual(len(self.menu["apps"]), 7)
        for _ in range(6):
            self.press("C")
        self.assertEqual(self.menu["page"], 1)
        self.assertEqual(len(self.menu["icons"]), 1)
        self.assertEqual(self.press("B"), "/system/apps/underhive")

    def test_previous_wraps_and_next_restores_first_page(self):
        self.press("A")
        self.assertEqual(self.menu["active"], 6)
        self.press("C")
        self.assertEqual(self.menu["page"], 0)
        self.assertEqual(self.press("B"), "/system/apps/quest")


if __name__ == "__main__":
    unittest.main()
