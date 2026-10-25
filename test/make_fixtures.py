# Builds test decks with the official Anki library (pip install anki).
import os, sys, tempfile, struct, zlib
from anki.collection import Collection, ExportAnkiPackageOptions, DeckIdLimit
from anki.scheduler.v3 import CardAnswer  # noqa

out = sys.argv[1]
tmp = tempfile.mkdtemp()
col = Collection(os.path.join(tmp, "c.anki2"))

def png(path, color):
    w = h = 8
    raw = b"".join(b"\x00" + bytes(color) * w for _ in range(h))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

p = os.path.join(tmp, "heart.png"); png(p, (220, 30, 30))
heart = col.media.add_file(p)

parent = col.decks.id("Medicine")
cardio = col.decks.id("Medicine::Cardiology")
basic = col.models.by_name("Basic")
rev = col.models.by_name("Basic (and reversed card)")
cloze = col.models.by_name("Cloze")

def add(model, did, fields, tags=()):
    n = col.new_note(model)
    for k, v in fields.items(): n[k] = v
    n.tags = list(tags)
    col.add_note(n, did)
    return n

add(basic, cardio, {"Front": f'What does this show? <img src="{heart}">', "Back": "A <b>heart</b>"}, ["anatomy"])
add(basic, cardio, {"Front": "Normal resting heart rate?", "Back": "60–100 bpm"})
add(rev, parent, {"Front": "Tachycardia", "Back": "HR &gt; 100 bpm"})
add(cloze, parent, {"Text": "The {{c1::mitral::valve name}} valve sits between the left atrium and {{c2::left ventricle}}.", "Back Extra": "Also called bicuspid"})
add(basic, parent, {"Front": r"Cardiac output formula: \(CO = HR \times SV\)", "Back": "Liters/min"})

# Give two cards review history so scheduling import can be tested.
col.sched.set_due_date(list(col.find_cards("resting"))[:1], "3")
for cid in col.find_cards("Tachycardia")[:1]:
    card = col.get_card(cid); card.start_timer()
    states = col.sched.col._backend.get_scheduling_states(card.id)
    col.sched.answer_card(col.sched.build_answer(card=card, states=states, rating=CardAnswer.GOOD))
col.save() if hasattr(col, "save") else None

def export(name, legacy, colpkg=False):
    path = os.path.join(out, name)
    if colpkg:
        col.export_collection_package(path, include_media=True, legacy=legacy)
    else:
        col.export_anki_package(out_path=path, options=ExportAnkiPackageOptions(with_scheduling=True, with_deck_configs=False, with_media=True, legacy=legacy), limit=DeckIdLimit(parent))
    print("wrote", path, os.path.getsize(path))

export("modern.apkg", legacy=False)
export("legacy.apkg", legacy=True)
export("full.colpkg", legacy=False, colpkg=True)
