"""M21 A: the project archive (docs/mach-next/M21_EXPORT_IMPORT.md, sections 2.1 to 2.3 and 7.2).

Covers a round trip, byte-for-byte determinism, the writer's refusals, and one hostile archive per refusal of the
reader, each built by hand with zipfile, with the sentence the person reads. A member at exactly its limit passes;
one byte more is refused.
"""

import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "studio" / "scripts"))
import project_archive as pa  # noqa: E402
from project_archive import ArchiveError  # noqa: E402

MIB = 1024 * 1024
SPEC = "workspace/specs/slices/SLICE-001-invite.md"
SLICE = "workspace/product/slices/SLICE-001.json"
MOCK = "workspace/product/mocks/SLICE-001/" + "a" * 64 + ".png"
META = {"mach_version": "0.24.0", "exported_at": "2026-11-24T13:06:00Z", "project_id": "team-space",
        "counts": {"epics": 1, "slices": 1, "principles": 0, "needs": 0, "ideas": 0, "prds": 0, "designs": 0, "mocks": 0}}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sample() -> dict:
    return {
        "facts.json": b'{"schema_version": 1}\n',
        "workspace/product/project.json": b'{"project_id": "team-space"}\n',
        "workspace/product/epics/EPIC-001.json": b'{"epic_id": "EPIC-001"}\n',
        SLICE: b'{"slice_id": "SLICE-001"}\n',
        "workspace/product/intents/SLICE-001.md": "# Intent: invite a teammate\n\nWhy it matters \u2014 a note.\n".encode(),
        SPEC: b"# SLICE-001: Invite a teammate\n",
        "workspace/product/principles.json": b"{}\n",
        "workspace/product/needs.json": b"{}\n",
        MOCK: b"\x89PNG\r\n\x1a\nnot really",
        "workspace/product/ideas/IDEA-001.json": b"{}\n",
        "workspace/product/ideas/IDEA-001.lookups.json": b"{}\n",
        "workspace/product/ideas/IDEA-001.map.json": b"{}\n",
        "workspace/product/briefs/IDEA-001.md": b"# Brief\n",
        "workspace/product/briefs/IDEA-001.case.md": b"# Case\n",
        "workspace/product/prds/PRD-01/prd.json": b"{}\n",
        "workspace/product/prds/PRD-01/map.json": b"{}\n",
        "workspace/product/prds/PRD-01/document.md": b"# PRD\n",
        "workspace/product/prds/PRD-01/answers/invite-flow.json": b"{}\n",
        "workspace/product/designs/DES-01/import.json": b"{}\n",
        "workspace/product/designs/DES-01/map.json": b"{}\n",
        "workspace/product/designs/DES-01/design.txt": b"Design\n",
    }


def manifest_for(members: dict, **override) -> dict:
    manifest = {"format": pa.FORMAT, "format_version": pa.FORMAT_VERSION, **META,
                "files": [{"path": name, "bytes": len(data), "sha256": sha(data)} for name, data in sorted(members.items())]}
    manifest.update(override)
    return manifest


class Base(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="mach-archive-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.path = self.root / "in.zip"

    def hostile(self, members: dict, manifest=None, entries=None, after=None, compression=zipfile.ZIP_DEFLATED) -> Path:
        """An archive built by hand: `members` (name to bytes) with a manifest that lists them truly unless `manifest`
        (a dict or raw bytes) is given; `entries` adds raw (ZipInfo, bytes) pairs; `after(archive)` changes the
        ZipInfo records before the central directory is written."""
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # zipfile warns on a duplicate name, which is the point of some tests
            with zipfile.ZipFile(self.path, "w", compression=compression) as archive:
                if manifest is not False:
                    body = manifest if isinstance(manifest, bytes) else json.dumps(manifest or manifest_for(members)).encode()
                    archive.writestr(pa.MANIFEST, body)
                for name, data in members.items():
                    archive.writestr(name, data)
                for info, data in entries or ():
                    archive.writestr(info, data)
                if after:
                    after(archive)
        return self.path

    def refused(self, sentence: str, path=None) -> None:
        with self.assertRaises(ArchiveError) as caught:
            pa.read(path or self.path)
        self.assertEqual(str(caught.exception), sentence)

    def unsafe(self, reason: str) -> None:
        self.refused(f"in.zip is not in a form MACH can read safely: {reason}.")


class WriteTest(Base):
    def test_round_trip(self):
        files = sample()
        target = self.root / "out" / "mach-project-team-space-20261124T130600Z.zip"
        manifest = pa.write(target, files, META)
        self.assertEqual(manifest["format"], "mach-project-archive")
        self.assertEqual(manifest["format_version"], 1)
        self.assertEqual(manifest["project_id"], "team-space")
        self.assertEqual([entry["path"] for entry in manifest["files"]], sorted(files))
        self.assertNotIn(pa.MANIFEST, [entry["path"] for entry in manifest["files"]])
        read_manifest, members = pa.read(target)
        self.assertEqual(read_manifest, manifest)
        self.assertEqual(members, files)
        self.assertFalse(target.with_name(target.name + ".tmp").exists())
        with zipfile.ZipFile(target) as archive:
            self.assertEqual(archive.read(pa.MANIFEST), pa.canonical(manifest))

    def test_the_same_input_gives_the_same_bytes(self):
        files = sample()
        first, second = self.root / "a.zip", self.root / "b.zip"
        pa.write(first, files, META)
        pa.write(second, dict(reversed(list(files.items()))), dict(reversed(list(META.items()))))
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with zipfile.ZipFile(first) as archive:
            infos = archive.infolist()
            self.assertEqual(archive.comment, b"")
        self.assertEqual([info.filename for info in infos], sorted(list(files) + [pa.MANIFEST]))
        for info in infos:
            self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
            self.assertEqual(info.external_attr >> 16, 0o100644)
            self.assertEqual(info.compress_type, zipfile.ZIP_DEFLATED)
            self.assertEqual(info.extra, b"")
            self.assertEqual(info.comment, b"")
        # Only exported_at changes between two exports of the same workspace.
        later = self.root / "c.zip"
        pa.write(later, files, {**META, "exported_at": "2026-11-25T09:00:00Z"})
        self.assertNotEqual(later.read_bytes(), first.read_bytes())
        self.assertEqual(pa.read(later)[1], pa.read(first)[1])

    def test_a_member_at_its_limit_is_written_and_read_one_byte_more_is_refused(self):
        for name, kind in ((SPEC, "markdown"), (SLICE, "json"), ("workspace/product/prds/PRD-01/document.txt", "document"), (MOCK, "mock")):
            limit = pa.LIMITS[kind]
            at = os.urandom(limit)  # random, so the mock does not look like a bomb
            target = self.root / f"{kind}.zip"
            pa.write(target, {name: at}, META)
            self.assertEqual(pa.read(target)[1][name], at)
            with self.assertRaises(ArchiveError) as caught:
                pa.write(target, {name: at + b"x"}, META)
            self.assertEqual(str(caught.exception), f"{name} is larger than {pa.words(limit)}, the most a file in an archive may be.")
            self.assertEqual(pa.read(target)[1][name], at)  # the earlier archive is untouched
        self.assertEqual(pa.words(pa.LIMITS["document"]), "512 KB")

    def test_a_name_no_pattern_matches_is_refused_and_nothing_is_written(self):
        target = self.root / "out.zip"
        for name in ("workspace/product/notes.txt", "../facts.json", "workspace/specs/slices/SLICE-001.md", "WORKSPACE/product/project.json"):
            with self.assertRaises(ArchiveError) as caught:
                pa.write(target, {name: b"x"}, META)
            self.assertEqual(str(caught.exception), f"{name} is not a file a project archive holds.")
        self.assertEqual(list(self.root.iterdir()), [])
        with self.assertRaises(ValueError):
            pa.write(target, {pa.MANIFEST: b"{}"}, META)
        with self.assertRaises(ValueError):
            pa.write(target, {SPEC: "text, not bytes"}, META)
        for meta in ({**META, "project_id": "Team Space"}, {**META, "exported_at": "yesterday"}, {**META, "extra": 1},
                     {key: value for key, value in META.items() if key != "counts"}, {**META, "counts": {"slices": -1}},
                     {**META, "mach_version": 3}):
            with self.assertRaises(ValueError):
                pa.write(target, sample(), meta)
        pa.write(target, sample(), {**META, "mach_version": None})  # said unknown, not guessed
        self.assertIsNone(pa.read(target)[0]["mach_version"])

    def test_two_names_equal_but_for_case_are_refused(self):
        upper, lower = "workspace/product/prds/PRD-01/answers/Invite.json", "workspace/product/prds/PRD-01/answers/invite.json"
        with self.assertRaises(ArchiveError) as caught:
            pa.write(self.root / "out.zip", {upper: b"{}", lower: b"{}"}, META)
        self.assertEqual(str(caught.exception), f"{lower} and {upper} have the same name but for case.")

    def test_an_archive_over_its_size_or_total_is_refused_and_leaves_no_file(self):
        target = self.root / "out.zip"
        with mock.patch.dict(pa.LIMITS, {"archive": 1000}):
            with self.assertRaises(ArchiveError) as caught:
                pa.write(target, {MOCK: os.urandom(4000)}, META)
        self.assertEqual(str(caught.exception), "The project is 1 MB, more than the 1000 bytes an archive may be. "
                                                "Remove design mocks that are no longer needed, then export again.")
        self.assertEqual(list(self.root.iterdir()), [])
        with mock.patch.dict(pa.LIMITS, {"total": 2 * MIB}):
            with self.assertRaises(ArchiveError) as caught:
                pa.write(target, {MOCK: os.urandom(2 * MIB)}, META)
        self.assertEqual(str(caught.exception), "The project is 3 MB unpacked, more than the 2 MB an archive may hold. "
                                                "Remove design mocks that are no longer needed, then export again.")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_a_member_the_reader_would_call_a_bomb_is_refused(self):
        with self.assertRaises(ArchiveError) as caught:
            pa.write(self.root / "out.zip", {MOCK: bytes(4 * MIB)}, META)
        self.assertIn("packs so tightly", str(caught.exception))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_a_stale_temporary_file_or_link_is_replaced_not_followed(self):
        target = self.root / "out.zip"
        elsewhere = self.root / "elsewhere"
        elsewhere.write_bytes(b"keep")
        target.with_name("out.zip.tmp").symlink_to(elsewhere)
        pa.write(target, sample(), META)
        self.assertEqual(elsewhere.read_bytes(), b"keep")
        self.assertFalse(target.with_name("out.zip.tmp").exists())


class ReadFileTest(Base):
    def test_no_file(self):
        self.refused(f"There is no file at {self.root / 'missing.zip'}.", self.root / "missing.zip")
        self.refused(f"There is no file at {self.root}.", self.root)

    def test_the_archive_is_a_symbolic_link(self):
        real = self.root / "real.zip"
        pa.write(real, sample(), META)
        self.path.symlink_to(real)
        self.unsafe("it is a link to another file")

    def test_the_archive_is_larger_than_256_mb(self):
        with open(self.path, "wb") as handle:
            handle.truncate(256 * MIB + 1)  # sparse: nothing is read
        self.unsafe("it is larger than 256 MB")

    def test_not_a_zip(self):
        self.path.write_bytes(b"just some text\n")
        self.refused("in.zip is not a project archive from MACH.")

    def test_no_manifest(self):
        self.hostile(sample(), manifest=False)
        self.refused("in.zip is not a project archive from MACH.")

    def test_a_manifest_named_in_other_case_is_not_the_manifest(self):
        with zipfile.ZipFile(self.path, "w") as archive:
            archive.writestr("MACH-PROJECT.json", json.dumps(manifest_for({})))
        self.refused("in.zip is not a project archive from MACH.")

    def test_a_malformed_manifest(self):
        files = sample()
        for body in (b"{not json", b"[]", b"\xff\xfe", json.dumps(manifest_for(files, format="zip")).encode(),
                     json.dumps(manifest_for(files, format_version="1")).encode(), json.dumps(manifest_for(files, format_version=True)).encode(),
                     json.dumps(manifest_for(files, format_version=0)).encode(), json.dumps(manifest_for(files, files={})).encode(),
                     json.dumps(manifest_for(files, project_id="../x")).encode(), json.dumps(manifest_for(files, extra=1)).encode(),
                     json.dumps(manifest_for(files, files=[{"path": SPEC, "bytes": 1}])).encode()):
            with self.subTest(body=body[:40]):
                self.hostile(files, manifest=body)
                self.refused("in.zip is not a project archive from MACH.")

    def test_a_newer_format(self):
        self.hostile(sample(), manifest=manifest_for(sample(), format_version=2))
        self.refused("in.zip was made by a newer MACH (archive format 2). Update MACH here, then import it again.")

    def test_a_newer_format_is_named_even_with_members_this_version_does_not_know(self):
        files = {**sample(), "workspace/product/roadmap.json": b"{}"}
        self.hostile(files, manifest=manifest_for(files, format_version=7))
        self.refused("in.zip was made by a newer MACH (archive format 7). Update MACH here, then import it again.")


class ReadMembersTest(Base):
    def test_more_than_5000_members(self):
        files = {f"workspace/product/slices/SLICE-{n:04d}.json": b"{}" for n in range(5000)}
        self.hostile(files)
        self.unsafe("it holds more than 5,000 files")

    def test_names_that_would_be_written_outside_the_project(self):
        for name in ("../x", "/etc/x", "workspace/../../x", "workspace/product/slices/..\\x", "C:/x", "c:x",
                     "workspace//product/project.json", "./facts.json", "workspace/./product/project.json"):
            with self.subTest(name=name):
                self.hostile({**sample(), name: b"x"})
                self.unsafe(f"a file in it would be written outside the project ({name})")

    def test_a_name_holding_a_nul(self):
        good = "workspace/product/briefs/IDEA-001.md"
        self.hostile({good: b"# Brief\n", "facts.jsonXworkspace": b"{}"}, manifest=manifest_for({good: b"# Brief\n"}))
        raw = self.path.read_bytes()
        self.assertEqual(raw.count(b"facts.jsonXworkspace"), 2)  # the local header and the central directory
        self.path.write_bytes(raw.replace(b"facts.jsonXworkspace", b"facts.json\x00workspace"))
        self.unsafe("a file in it would be written outside the project (facts.json?workspace)")

    def test_names_mach_does_not_know(self):
        for name in ("workspace/product/notes.txt", "workspace/product/slices/SLICE-01.json", "workspace/product/slices/slice-001.json",
                     "workspace/specs/slices/SLICE-001-Invite.md", "workspace/product/mocks/SLICE-001/" + "A" * 64 + ".png",
                     "workspace/product/mocks/SLICE-001/" + "a" * 64 + ".gif", "workspace/.factory/x.json", "x.json",
                     "workspace/product/slices/SLICE-001.json.tmp", "workspace/product/prds/PRD-01/answers/1x.json",
                     "workspace/product/slices/SLICE-00\u00e9.json", "workspace/product/slices/SLICE-001 .json"):
            with self.subTest(name=name):
                self.hostile({**sample(), name: b"x"})
                self.unsafe(f"it holds a folder or file MACH does not know ({name})")

    def test_names_differing_only_by_unicode_normalisation_are_refused(self):
        nfc, nfd = "workspace/product/briefs/IDEA-001-\u00e9.md", "workspace/product/briefs/IDEA-001-e\u0301.md"
        self.assertEqual(pa._fold(nfc), pa._fold(nfd))
        self.hostile({nfc: b"a", nfd: b"b"})
        with self.assertRaises(ArchiveError) as caught:
            pa.read(self.path)
        self.assertIn("in.zip is not in a form MACH can read safely: ", str(caught.exception))

    def test_a_folder_entry(self):
        self.hostile(sample(), entries=[(zipfile.ZipInfo("workspace/product/"), b"")])
        self.unsafe("it holds a folder or file MACH does not know (workspace/product/)")

    def test_a_folder_marked_only_by_its_attributes(self):
        info = zipfile.ZipInfo("workspace/product/project.json")
        info.external_attr = (stat.S_IFDIR | 0o755) << 16 | 0x10
        files = sample()
        data = files.pop("workspace/product/project.json")
        self.hostile(files, manifest=manifest_for({**files, info.filename: data}), entries=[(info, data)])
        self.unsafe("it holds a folder or file MACH does not know (workspace/product/project.json)")

    def test_two_members_with_the_same_name(self):
        files = sample()
        self.hostile(files, entries=[(zipfile.ZipInfo(SPEC), b"# SLICE-001: Something else\n")])
        self.unsafe("two files in it have the same name")

    def test_two_manifests(self):
        self.hostile(sample(), entries=[(zipfile.ZipInfo(pa.MANIFEST), b"{}")])
        self.unsafe("two files in it have the same name")

    def test_two_names_equal_but_for_case(self):
        upper, lower = "workspace/product/prds/PRD-01/answers/Invite.json", "workspace/product/prds/PRD-01/answers/invite.json"
        self.hostile({**sample(), upper: b"{}", lower: b"{}"})
        self.unsafe("two files in it have the same name")

    def test_a_symbolic_link_member(self):
        info = zipfile.ZipInfo(SPEC)
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        files = sample()
        files.pop(SPEC)
        self.hostile(files, manifest=manifest_for({**files, SPEC: b"/etc/passwd"}), entries=[(info, b"/etc/passwd")])
        self.unsafe("it holds a link to another file")

    def test_another_file_type(self):
        info = zipfile.ZipInfo(SPEC)
        info.external_attr = (stat.S_IFIFO | 0o644) << 16
        files = sample()
        files.pop(SPEC)
        self.hostile(files, manifest=manifest_for({**files, SPEC: b"x"}), entries=[(info, b"x")])
        self.unsafe(f"it holds a folder or file MACH does not know ({SPEC})")

    def test_a_member_with_no_mode_recorded_is_a_regular_file(self):
        info = zipfile.ZipInfo(SPEC)
        info.external_attr = 0
        files = sample()
        data = files.pop(SPEC)
        self.hostile(files, manifest=manifest_for({**files, SPEC: data}), entries=[(info, data)])
        self.assertEqual(pa.read(self.path)[1][SPEC], data)

    def test_an_encrypted_member(self):
        def encrypt(archive):
            archive.getinfo(SPEC).flag_bits |= 0x1
        self.hostile(sample(), after=encrypt)
        self.unsafe("it is encrypted")

    def test_a_compression_mach_does_not_read(self):
        self.hostile(sample(), compression=zipfile.ZIP_BZIP2)
        self.unsafe(f"a file in it is packed in a way MACH does not read ({pa.MANIFEST})")

    def test_a_member_declared_over_its_limit(self):
        for name, kind in ((MOCK, "mock"), (SPEC, "markdown"), (SLICE, "json"), ("workspace/product/designs/DES-01/design.md", "document")):
            for declared in (pa.LIMITS[kind] + 1, 600 * MIB):
                with self.subTest(name=name, declared=declared):
                    def inflate(archive, name=name, declared=declared):
                        archive.getinfo(name).file_size = declared
                    self.hostile({**sample(), name: b"small"}, after=inflate)
                    self.unsafe(f"a file in it is larger than {pa.words(pa.LIMITS[kind])} ({name})")

    def test_a_member_actually_over_its_limit(self):
        data = b"a" * (pa.LIMITS["markdown"] + 1)
        self.hostile({SPEC: data})
        self.unsafe(f"a file in it is larger than 1 MB ({SPEC})")

    def test_a_member_exactly_at_its_limit_passes(self):
        data = b"a" * pa.LIMITS["markdown"]  # highly compressible, but not over 1 MiB, so not a bomb
        self.hostile({SPEC: data})
        self.assertEqual(pa.read(self.path)[1][SPEC], data)

    def test_a_manifest_over_its_limit(self):
        def inflate(archive):
            archive.getinfo(pa.MANIFEST).file_size = pa.LIMITS["json"] + 1
        self.hostile(sample(), after=inflate)
        self.unsafe(f"a file in it is larger than 1 MB ({pa.MANIFEST})")

    def test_a_total_over_512_mb(self):
        mocks = {f"workspace/product/mocks/SLICE-{n:03d}/{'b' * 64}.png": b"tiny" for n in range(1, 104)}

        def inflate(archive):
            for name in mocks:
                archive.getinfo(name).file_size = 5 * MIB
        self.hostile(mocks, after=inflate)
        self.unsafe("it unpacks to more than 512 MB")

    def test_a_bomb(self):
        self.hostile({MOCK: bytes(4 * MIB)})  # 4 MiB of zeros packs to a few KiB
        self.unsafe("it unpacks to far more than it holds")

    def test_more_bytes_than_declared(self):
        def shrink(archive):
            archive.getinfo(SPEC).file_size = 3
        self.hostile(sample(), after=shrink, compression=zipfile.ZIP_STORED)
        self.unsafe(f"a file in it is damaged ({SPEC})")

    def test_fewer_bytes_than_declared(self):
        def grow(archive):
            archive.getinfo(SPEC).file_size += 10
        self.hostile(sample(), after=grow)
        self.unsafe(f"a file in it is damaged ({SPEC})")

    def test_a_crc_error(self):
        self.hostile(sample(), compression=zipfile.ZIP_STORED)
        raw = self.path.read_bytes()
        self.assertEqual(raw.count(b"Invite a teammate"), 1)
        self.path.write_bytes(raw.replace(b"Invite a teammate", b"Invite a teammatE"))
        self.unsafe(f"a file in it is damaged ({SPEC})")

    def test_a_local_header_naming_another_file(self):
        self.hostile({SPEC: b"# SLICE-001: x\n"}, compression=zipfile.ZIP_STORED)
        raw = self.path.read_bytes()
        name = SPEC.encode()
        self.assertEqual(raw.count(name), 3)  # the stored manifest, the local header, the central directory
        local = raw.index(name, raw.index(name) + 1)
        self.path.write_bytes(raw[:local] + SPEC.replace("invite", "inviTE").encode() + raw[local + len(name):])
        self.unsafe(f"a file in it is damaged ({SPEC})")


class ReadManifestListTest(Base):
    def test_a_changed_byte(self):
        files = sample()
        self.hostile({**files, SPEC: b"# SLICE-001: Invite a stranger\n"}, manifest=manifest_for(files))
        self.refused(f"in.zip has been changed since it was exported: {SPEC} does not match the archive's own list.")

    def test_a_member_added(self):
        files = sample()
        extra = "workspace/product/epics/EPIC-002.json"
        self.hostile({**files, extra: b"{}"}, manifest=manifest_for(files))
        self.refused(f"in.zip has been changed since it was exported: {extra} does not match the archive's own list.")

    def test_a_member_removed(self):
        files = sample()
        kept = dict(files)
        kept.pop(SLICE)
        self.hostile(kept, manifest=manifest_for(files))
        self.refused(f"in.zip has been changed since it was exported: {SLICE} does not match the archive's own list.")

    def test_a_size_that_does_not_match(self):
        files = sample()
        manifest = manifest_for(files)
        for entry in manifest["files"]:
            if entry["path"] == SLICE:
                entry["bytes"] += 1
        self.hostile(files, manifest=manifest)
        self.refused(f"in.zip has been changed since it was exported: {SLICE} does not match the archive's own list.")

    def test_a_path_listed_twice(self):
        files = sample()
        manifest = manifest_for(files)
        manifest["files"].append(dict(manifest["files"][0]))
        self.hostile(files, manifest=manifest)
        self.refused(f"in.zip has been changed since it was exported: {manifest['files'][0]['path']} does not match the archive's own list.")

    def test_the_manifest_listing_itself(self):
        files = sample()
        manifest = manifest_for(files)
        manifest["files"].append({"path": pa.MANIFEST, "bytes": 1, "sha256": "0" * 64})
        self.hostile(files, manifest=manifest)
        self.refused(f"in.zip has been changed since it was exported: {pa.MANIFEST} does not match the archive's own list.")

    def test_a_hand_built_archive_that_follows_every_rule_is_read(self):
        files = sample()
        self.hostile(files)
        manifest, members = pa.read(self.path)
        self.assertEqual(members, files)
        self.assertEqual(manifest["project_id"], "team-space")


class PatternsTest(unittest.TestCase):
    def test_every_pattern_has_a_limit_and_the_limits_match_studio(self):
        for pattern, kind in pa.MEMBER_PATTERNS:
            self.assertIn(kind, pa.LIMITS, pattern.pattern)
        sys.path.insert(0, str(ROOT / "skills" / "ticket" / "scripts"))
        import issue_rules
        import prd
        import product
        self.assertEqual(pa.LIMITS["json"], product.MAX_JSON_BYTES)
        self.assertEqual(pa.LIMITS["document"], prd.MAX_BYTES)
        self.assertEqual(pa.LIMITS["mock"], issue_rules.MOCK_MAX_BYTES)
        self.assertEqual(pa.PROJECT_RE.pattern, product.PROJECT_RE.pattern)
        self.assertEqual(pa._MAP_KEY, prd.MAP_KEY_RE.pattern.strip("^$"))
        for name in ("SLICE-001-invite.md", "SLICE-1234-a-b-c.md", "SLICE-01-x.md", "SLICE-001-.md", "SLICE-001-Invite.md", "SLICE-001-a--b.md", "SLICE-001.md"):
            self.assertEqual(bool(pa.kind_of("workspace/specs/slices/" + name)), bool(product.SPEC_NAME_RE.fullmatch(name)), name)

    def test_the_documented_layout(self):
        for name in sample():
            self.assertTrue(pa.kind_of(name), name)
        self.assertEqual(pa.kind_of(pa.MANIFEST), "json")
        self.assertEqual(pa.kind_of(MOCK), "mock")
        self.assertEqual(pa.kind_of("workspace/product/prds/PRD-01/document.md"), "document")
        self.assertEqual(pa.kind_of("workspace/product/designs/DES-01/design.md"), "document")
        self.assertEqual(pa.kind_of("workspace/product/ready/SLICE-001/spec.md"), "")  # ready folders stay behind


if __name__ == "__main__":
    unittest.main()
