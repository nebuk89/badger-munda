import os
import sys

sys.path.insert(0, "/system/apps/menu")
os.chdir("/system/apps/menu")

from badgeware import screen, PixelFont, Image, is_dir, file_exists, brushes, io, run
from icon import Icon
import ui

PREFERRED = [
    ("mona's quest", "quest"),
    ("mona pet", "monapet"),
    ("monasketch", "sketch"),
    ("flappy mona", "flappy"),
    ("gallery", "gallery"),
    ("badge", "badge"),
    ("underhive", "underhive"),
]

apps = [(name, folder) for name, folder in PREFERRED
        if file_exists("/system/apps/" + folder + "/__init__.py")]
known = [folder for _, folder in apps]
for folder in sorted(os.listdir("/system/apps")):
    root = "/system/apps/" + folder
    if folder not in known and folder not in ("menu", "startup") and is_dir(root):
        if file_exists(root + "/__init__.py"):
            apps.append((folder, folder))

screen.font = PixelFont.load("/system/assets/fonts/ark.ppf")
active = 0
page = -1
icons = []


def load_page(number):
    global icons, page
    icons = []
    page = number
    for index, (name, folder) in enumerate(apps[page * 6:page * 6 + 6]):
        filename = "/system/apps/" + folder + "/icon.png"
        if not file_exists(filename):
            filename = "/system/apps/badge/icon.png"
        sprite = Image.load(filename)
        position = (index % 3 * 48 + 33, index // 3 * 48 + 42)
        icons.append(Icon(position, name, index, sprite))


def update():
    global active
    if not apps:
        screen.brush = brushes.color(0, 0, 0)
        screen.clear()
        screen.brush = brushes.color(255, 255, 255)
        screen.text("No apps found", 8, 50)
        return
    if io.BUTTON_A in io.pressed:
        active = (active - 1) % len(apps)
    if io.BUTTON_C in io.pressed:
        active = (active + 1) % len(apps)
    if io.BUTTON_UP in io.pressed:
        active = (active - 3) % len(apps)
    if io.BUTTON_DOWN in io.pressed:
        active = (active + 3) % len(apps)
    if io.BUTTON_B in io.pressed:
        return "/system/apps/" + apps[active][1]
    if page != active // 6:
        load_page(active // 6)
    ui.draw_background()
    ui.draw_header()
    for index, icon in enumerate(icons):
        icon.activate(index == active % 6)
        icon.draw()
    screen.brush = brushes.color(211, 250, 55)
    name = apps[active][0]
    width, _ = screen.measure_text(name)
    screen.text(name, (160 - width) // 2, 100)
    screen.text(str(page + 1) + "/" + str((len(apps) + 5) // 6), 138, 110)


if __name__ == "__main__":
    run(update)
