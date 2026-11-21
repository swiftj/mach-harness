#!/usr/bin/env python3
"""Run the test classes a change can affect, and say why each was chosen.

    python3 tests/affected.py                 # this branch against main, plus uncommitted and untracked files
    python3 tests/affected.py PATH...         # these changed files instead
    python3 tests/affected.py --list --why    # print the classes and one reason each; run nothing

The map is read from the code, not kept by hand. Every Python file in the repository is parsed. A
module it imports (by name, from the folders it puts on `sys.path`, its own folder or tests/), and
every repository file or folder it names by path (`ROOT / "skills" / "run" / "scripts" / "run.py"`,
a file name such as "cell.py" in a by-path load or a subprocess, a folder it walks or builds in),
is something it reads. That is followed through the scripts' own imports and by-path loads, so a
test that runs run.py is chosen when a script run.py loads changes. A name found inside a test
class counts for that class and its subclasses; one found elsewhere in a test module counts for
every class in it; importing names from another test module reads its module-level code and the
classes named, and importing it whole reads all of it. A table (TABLE, empty today) adds what code
cannot show.

It fails safe. A changed file that nothing names, outside the folders no Python test reads unless it
names them (docs, video, web, apps, .github), means every class runs, and it says so. So does a
change to the test runner, this selector, the Makefile, a shared test helper, issue_rules.py, or a
module most classes reach. A changed file no test reads, inside those folders, selects nothing, and
that is said too.

The whole suite still runs before a merge: this is for the loop while working. Standard library only.
"""

from __future__ import annotations

import argparse
import ast
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Dict, Iterable, List, Optional, Set, Tuple

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
sys.path.insert(0, str(TESTS))
import in_parallel  # noqa: E402

# Changes that mean "run everything", whatever the map says.
EVERYTHING = {
    "tests/in_parallel.py": "the test runner itself changed",
    "tests/affected.py": "this selector itself changed",
    "Makefile": "the Makefile changed",
    "skills/ticket/scripts/issue_rules.py": "issue_rules.py is shared by most stations and Product Studio",
}
# A changed file in these folders that no Python file names is read by no test: it selects nothing.
NOT_READ_BY_TESTS = ("docs/", "video/", "web/", "apps/", ".github/")
NOT_READ_BY_TESTS_FILES = {"LICENSE"}
# What code cannot show: a changed path (prefix) -> test modules that read it some other way.
TABLE: Dict[str, Tuple[str, ...]] = {}
# A Python file reached by more than this share of all classes is treated as shared by everything.
MOST = 0.6


def git(*args: str) -> str:
    done = subprocess.run(["git", *args], cwd=str(ROOT), capture_output=True, text=True)
    return done.stdout if done.returncode == 0 else ""


def repo_files() -> List[str]:
    names = git("ls-files", "-z").split("\0") + git("ls-files", "-z", "--others", "--exclude-standard").split("\0")
    return sorted({name for name in names if name and (ROOT / name).is_file()})


def changed_files() -> List[str]:
    base = git("merge-base", "HEAD", "main").strip()
    names: Set[str] = set()
    if base:
        names.update(git("diff", "--name-only", base, "HEAD").split("\n"))
    names.update(git("diff", "--name-only", "HEAD").split("\n"))
    names.update(git("ls-files", "--others", "--exclude-standard").split("\n"))
    return sorted(name for name in names if name)


def is_python(name: str) -> bool:
    if name.endswith(".py"):
        return True
    if "." in PurePosixPath(name).name:
        return False
    try:
        with open(ROOT / name, "rb") as handle:
            first = handle.readline(200)
    except OSError:
        return False
    return first.startswith(b"#!") and b"python" in first


def test_module(name: str) -> bool:
    return name.startswith("tests/test_") and name.endswith(".py") and name.count("/") == 1


class Reader:
    """What one Python file reads: modules it imports and repository paths it names, each tagged with the
    top-level class it sits in (None for anywhere else in the file)."""

    PASS_THROUGH = {"Path", "PurePath", "PosixPath", "str", "fspath", "realpath", "abspath", "normpath", "expanduser"}

    def __init__(self, name: str, tree: ast.Module, files: Set[str], dirs: Set[str],
                 by_name: Dict[str, List[str]], by_suffix: Dict[str, List[str]]):
        self.name, self.tree, self.files, self.dirs, self.by_name, self.by_suffix = name, tree, files, dirs, by_name, by_suffix
        self.file = str((ROOT / name).resolve())
        self.env: Dict[str, List[ast.AST]] = defaultdict(list)
        self.loops: Dict[str, Set[str]] = defaultdict(set)
        self.parents: Dict[ast.AST, ast.AST] = {}
        self.memo: Dict[int, Set[Tuple[str, bool]]] = {}
        self.owners: Dict[int, Optional[str]] = {}
        self.nodes: List[ast.AST] = []
        self.loop_iters: List[Tuple[str, ast.AST]] = []
        todo: List[Tuple[ast.AST, Optional[str]]] = [(tree, None)]
        while todo:  # one walk: every node, its parent, and the top-level class it sits in
            parent, owner = todo.pop()
            self.nodes.append(parent)
            self.owners[id(parent)] = owner
            for child in ast.iter_child_nodes(parent):
                self.parents[child] = parent
                todo.append((child, child.name if parent is tree and isinstance(child, ast.ClassDef) else owner))
            if isinstance(parent, ast.Assign):
                for target in parent.targets:
                    if isinstance(target, ast.Name):
                        self.env[target.id].append(parent.value)
            elif isinstance(parent, ast.AnnAssign) and isinstance(parent.target, ast.Name) and parent.value is not None:
                self.env[parent.target.id].append(parent.value)
            elif isinstance(parent, (ast.For, ast.comprehension)):
                # `for name in FILES` and `for name, script in ALIASES.items()`: each name may hold any text the iterable holds.
                for target in ast.walk(parent.target):
                    if isinstance(target, ast.Name):
                        self.loop_iters.append((target.id, parent.iter))
        for target, iterable in self.loop_iters:  # after every assignment is known, so `for name in FILES` finds FILES's text
            self.loops[target].update(self.texts(iterable))
        self.imports: List[Tuple[Optional[str], str, Optional[List[str]]]] = []  # owner, module, names (None: the module)
        self.aliases: Dict[str, Tuple[str, str]] = {}  # local name -> (module, name), or (module, "") for a module
        self.paths: List[Tuple[Optional[str], str]] = []
        self.search: Set[str] = set()

    def texts(self, node: ast.AST, depth: int = 0) -> Set[str]:
        """The text an expression's values can hold: its string constants, and those of the names (or self./cls.
        attributes) it uses, as they are assigned in this file."""
        found = self.strings(node)
        if depth < 3:
            for item in ast.walk(node):
                name = item.id if isinstance(item, ast.Name) else item.attr if isinstance(item, ast.Attribute) and \
                    isinstance(item.value, ast.Name) and item.value.id in ("self", "cls") else None
                for bound in self.env.get(name, []) if name else []:
                    found |= self.texts(bound, depth + 1)
        return found

    @staticmethod
    def strings(node: ast.AST) -> Set[str]:
        return {item.value for item in ast.walk(node) if isinstance(item, ast.Constant) and isinstance(item.value, str)}

    def owner(self, node: ast.AST) -> Optional[str]:
        found = self.owners.get(id(node))
        return None if found is not None and node is self.tree else found

    # -- path expressions ------------------------------------------------------------------------------------
    def value(self, node: ast.AST, depth: int = 0) -> Set[Tuple[str, bool]]:
        """Absolute paths this expression can name, each with whether it is complete (False: only a known prefix)."""
        key = id(node)
        if key in self.memo:
            return self.memo[key]
        self.memo[key] = set()  # guards against a name bound to itself
        found = self._value(node, depth) if depth < 16 else set()
        self.memo[key] = found
        return found

    def _value(self, node: ast.AST, depth: int) -> Set[Tuple[str, bool]]:
        if isinstance(node, ast.Name):
            if node.id == "__file__":
                return {(self.file, True)}
            found: Set[Tuple[str, bool]] = set()
            for bound in self.env.get(node.id, []):
                found |= self.value(bound, depth + 1)
            return found
        if isinstance(node, ast.Attribute):
            if node.attr == "parent":
                return {(os.path.dirname(p), c) for p, c in self.value(node.value, depth + 1)}
            return set()
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute) and node.value.attr == "parents":
            index = node.slice
            if isinstance(index, ast.Constant) and isinstance(index.value, int):
                out = set()
                for p, c in self.value(node.value.value, depth + 1):
                    for _ in range(index.value + 1):
                        p = os.path.dirname(p)
                    out.add((p, c))
                return out
            return set()
        if isinstance(node, ast.Call):
            func = node.func
            fname = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""
            if isinstance(func, ast.Attribute) and fname in ("resolve", "absolute", "expanduser") and not node.args:
                return self.value(func.value, depth + 1)
            if fname in self.PASS_THROUGH:
                return self.value(node.args[0], depth + 1) if node.args else set()
            if fname == "dirname" and node.args:
                return {(os.path.dirname(p), c) for p, c in self.value(node.args[0], depth + 1)}
            if fname == "join" and node.args and isinstance(func, ast.Attribute) and not isinstance(func.value, ast.Constant):
                out = self.value(node.args[0], depth + 1)
                for part in node.args[1:]:
                    out = self.extend(out, part)
                return out
            if fname == "joinpath" and isinstance(func, ast.Attribute):
                if any(self.spread_of_lambda(part) for part in node.args) and self.named_lambda(node):
                    return set()  # `read = lambda *parts: ROOT.joinpath(*parts)`: what it reads is read where `read(...)` is called
                out = self.value(func.value, depth + 1)
                for part in node.args:
                    out = self.extend(out, part)
                return out
            if isinstance(func, ast.Name):  # a call of such a lambda: its base path joined with the call's own parts
                out = set()
                for bound in self.env.get(func.id, []):
                    if not (isinstance(bound, ast.Lambda) and bound.args.vararg):
                        continue
                    for inner in ast.walk(bound.body):  # the joinpath, under any .read_text() and the like
                        if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute) and inner.func.attr == "joinpath" \
                                and [self.spread_of_lambda(part) for part in inner.args] == [True]:
                            for parts in self.spread_calls(node.args):
                                found = self.value(inner.func.value, depth + 1)
                                for part in parts:
                                    found = self.extend(found, part)
                                out |= found
                return out
            return set()
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            return self.extend(self.value(node.left, depth + 1), node.right)
        return set()

    def spread_calls(self, args: List[ast.AST]) -> List[List[ast.AST]]:
        """A call's arguments; for `read(*path)` with `for path in (("a", "b"), ("c",))`, each tuple's parts in turn."""
        if len(args) == 1 and isinstance(args[0], ast.Starred) and isinstance(args[0].value, ast.Name):
            choices = []
            for target, iterable in self.loop_iters:
                if target == args[0].value.id and isinstance(iterable, (ast.Tuple, ast.List)):
                    for item in iterable.elts:
                        if isinstance(item, (ast.Tuple, ast.List)):
                            choices.append(list(item.elts))
                        else:
                            return [args]
            if choices:
                return choices
        return [args]

    def named_lambda(self, node: ast.AST) -> bool:
        """Whether node sits in a lambda assigned to a name that is only ever called (so each call says what it reads)."""
        while node in self.parents and not isinstance(node, ast.Lambda):
            node = self.parents[node]
        assign = self.parents.get(node)
        if not (isinstance(node, ast.Lambda) and isinstance(assign, ast.Assign) and len(assign.targets) == 1
                and isinstance(assign.targets[0], ast.Name)):
            return False
        name = assign.targets[0].id
        uses = [item for item in self.nodes if isinstance(item, ast.Name) and item.id == name and isinstance(item.ctx, ast.Load)]
        return all(isinstance(self.parents.get(use), ast.Call) and self.parents[use].func is use for use in uses)

    def spread_of_lambda(self, part: ast.AST) -> bool:
        """`*parts`, where parts is the variable arguments of the lambda it sits in."""
        if not (isinstance(part, ast.Starred) and isinstance(part.value, ast.Name)):
            return False
        node = part
        while node in self.parents:
            node = self.parents[node]
            if isinstance(node, ast.Lambda):
                return bool(node.args.vararg) and node.args.vararg.arg == part.value.id
        return False

    def extend(self, bases: Set[Tuple[str, bool]], part: ast.AST) -> Set[Tuple[str, bool]]:
        if isinstance(part, ast.Constant) and isinstance(part.value, str):
            pieces = [part.value]
        elif isinstance(part, ast.Name) and self.loops.get(part.id):
            pieces = sorted(self.loops[part.id])
        elif isinstance(part, ast.Name) and self.env.get(part.id) and all(
                isinstance(bound, ast.Constant) and isinstance(bound.value, str) for bound in self.env[part.id]):
            pieces = sorted({bound.value for bound in self.env[part.id]})  # a name bound only to text, such as SPEC_NAME
        else:
            pieces = []
        out: Set[Tuple[str, bool]] = set()
        for base, complete in bases:
            if complete and pieces:
                out.update((os.path.normpath(os.path.join(base, piece)), True) for piece in pieces)
            else:
                out.add((base, False))
        return out

    @staticmethod
    def relative(absolute: str) -> Optional[str]:
        try:
            rel = Path(absolute).relative_to(ROOT).as_posix()
        except ValueError:
            return None
        return "" if rel == "." else rel

    # -- reading ---------------------------------------------------------------------------------------------
    def read(self) -> None:
        on_sys_path: Set[int] = set()
        for node in self.nodes:
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("insert", "append") \
                    and isinstance(node.func.value, ast.Attribute) and node.func.value.attr == "path" and node.args:
                target = node.args[-1]
                on_sys_path.update(id(item) for item in ast.walk(target))
                for absolute, complete in self.value(target):
                    rel = self.relative(absolute)
                    if rel is not None and complete:
                        self.search.add(rel)
        for node in self.nodes:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.imports.append((self.owner(node), alias.name.split(".")[0], None))
                    self.aliases[alias.asname or alias.name.split(".")[0]] = (alias.name.split(".")[0], "")
                continue
            if isinstance(node, ast.ImportFrom):
                if node.module and not node.level:
                    module = node.module.split(".")[0]
                    self.imports.append((self.owner(node), module, [alias.name for alias in node.names]))
                    for alias in node.names:
                        self.aliases[alias.asname or alias.name] = (module, alias.name)
                continue
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                for rel in self.literal(node.value):
                    self.paths.append((self.owner(node), rel))
            if id(node) in on_sys_path or not isinstance(node, (ast.BinOp, ast.Call, ast.Name, ast.Attribute, ast.Subscript)):
                continue
            parent = self.parents.get(node)
            if isinstance(parent, (ast.BinOp, ast.Attribute, ast.Subscript, ast.Call)) and self.value(parent):
                continue  # the larger expression is read instead
            for absolute, complete in self.value(node):
                rel = self.relative(absolute)
                if rel is None or absolute == self.file or (rel == "" and complete):
                    continue  # outside the repository, the file itself, or the repository root named alone
                if not complete and not test_module(self.name):
                    continue  # a script's folder named by a computed part: its file is named by a literal instead
                if not test_module(self.name) and rel in self.dirs and self.name.startswith(rel + "/"):
                    continue  # a script finding its own folders, not reading them
                if not complete or rel in self.dirs:
                    self.paths.append((self.owner(node), (rel + "/*") if rel else "*"))
                else:
                    self.paths.append((self.owner(node), rel))

    def literal(self, text: str) -> List[str]:
        """Repository files a string names: a file name ("cell.py"), or a path ("skills/run/SKILL.md")."""
        text = text.strip()
        if not text or len(text) > 200 or "\n" in text:
            return []
        if text.startswith("./"):
            text = text[2:]
        # A bare file name: a script by name ("cell.py", loaded by path from a folder worked out at run time), or a
        # file name only one repository file has. Other bare names ("README.md", "config.json") are what tests write
        # into their own temporary projects; a repository file of that name is reached by its path instead.
        candidates = self.by_name.get(text, []) if "." in text else []
        found = list(candidates) if text.endswith(".py") or len(candidates) == 1 else []
        if "/" in text:
            clean = text.strip("/")
            if clean in self.files:
                found.append(clean)
            elif clean in self.dirs:
                pass  # "tests/" or "docs/" as text is a folder in a temporary project; a repository folder is read by its path
            else:
                found.extend(self.by_suffix.get(clean, []))
        return found


class Map:
    """The repository's Python files and what each reads, as a graph of nodes. A node is a repository file,
    `tests/test_x.py::Class` for what one test class reads, or `tests/test_x.py#all` for a whole test module."""

    def __init__(self) -> None:
        self.files = repo_files()
        fileset = set(self.files)
        self.dirs: Set[str] = set()
        by_name: Dict[str, List[str]] = defaultdict(list)
        by_suffix: Dict[str, List[str]] = defaultdict(list)
        for name in self.files:
            parts = name.split("/")
            for i in range(1, len(parts)):
                self.dirs.add("/".join(parts[:i]))
            by_name[parts[-1]].append(name)
            for i in range(1, len(parts) - 1):
                by_suffix["/".join(parts[i:])].append(name)
        stems: Dict[str, List[str]] = defaultdict(list)
        python = [name for name in self.files if is_python(name)]
        for name in python:
            stems[PurePosixPath(name).stem].append(name)
        self.edges: Dict[str, Set[str]] = defaultdict(set)
        self.unparsed: Set[str] = set()
        self.classes_in: Dict[str, Set[str]] = defaultdict(set)
        for name in python:
            try:
                tree = ast.parse((ROOT / name).read_text(encoding="utf-8", errors="replace"))
            except (SyntaxError, ValueError):
                self.unparsed.add(name)
                continue
            reader = Reader(name, tree, fileset, self.dirs, by_name, by_suffix)
            reader.read()
            folder = str(PurePosixPath(name).parent)
            search = reader.search | {folder, "tests"}
            targets: List[Tuple[Optional[str], str]] = []
            def place(module: str) -> List[str]:
                candidates = stems.get(module, [])
                near = [c for c in candidates if str(PurePosixPath(c).parent) in search]
                return near or candidates

            for owner, module, imported in reader.imports:
                for target in place(module):
                    if test_module(target) and target != name:
                        # Another test module: its module-level code always, then the classes named, or all of it.
                        targets.append((owner, target))
                        targets += [(owner, f"{target}::{item}") for item in imported or []] if imported and "*" not in imported \
                            else [(owner, target + "#all")]
                    else:
                        targets.append((owner, target))
            targets += reader.paths
            is_test = test_module(name)
            if is_test:
                # A class's bases: one in this module, or one imported from another test module.
                for cls in tree.body:
                    if not isinstance(cls, ast.ClassDef):
                        continue
                    for base in cls.bases:
                        if isinstance(base, ast.Name) and base.id in {c.name for c in tree.body if isinstance(c, ast.ClassDef)}:
                            targets.append((cls.name, f"{name}::{base.id}"))
                        elif isinstance(base, ast.Name) and base.id in reader.aliases:
                            module, item = reader.aliases[base.id]
                            targets += [(cls.name, f"{t}::{item}") for t in place(module) if test_module(t)]
                        elif isinstance(base, ast.Attribute) and isinstance(base.value, ast.Name) and base.value.id in reader.aliases:
                            module, _ = reader.aliases[base.value.id]
                            targets += [(cls.name, f"{t}::{base.attr}") for t in place(module) if test_module(t)]
            for owner, target in targets:
                node = f"{name}::{owner}" if is_test and owner else name
                if is_test and owner:
                    self.classes_in[name].add(owner)
                if target != name:
                    self.edges[node].add(target)
            if is_test:
                self.edges[name + "#all"].add(name)
        # This selector parses every Python file in the repository, so its own tests read them all.
        self.edges["tests/affected.py"].update(name for name in python if name != "tests/affected.py")
        for name in list(self.classes_in):
            self.edges[name + "#all"].update(f"{name}::{owner}" for owner in self.classes_in[name])
        # Reverse edges, folder reads expanded to every file under the folder.
        self.readers: Dict[str, Set[str]] = defaultdict(set)
        self.folder_readers: Dict[str, Set[str]] = defaultdict(set)
        for node, targets in self.edges.items():
            for target in targets:
                if target == "*":
                    self.folder_readers[""].add(node)
                elif target.endswith("/*"):
                    self.folder_readers[target[:-2]].add(node)
                else:
                    self.readers[target].add(node)

    def direct_readers(self, name: str) -> Set[str]:
        found = set(self.readers.get(name, set()))
        if "#" not in name and "::" not in name:
            parts = name.split("/")
            for i in range(0, len(parts)):
                found |= self.folder_readers.get("/".join(parts[:i]), set())
        return found

    def ancestors(self, name: str) -> Set[str]:
        """Every node that reaches this file, directly or through what it reads."""
        seen: Set[str] = set()
        todo = [name]
        while todo:
            for reader in self.direct_readers(todo.pop()):
                if reader not in seen:
                    seen.add(reader)
                    todo.append(reader)
        return seen


def class_nodes(names: List[str]) -> Dict[str, Set[str]]:
    """For each `module.Class`, the nodes that stand for it: its module's own reads and its class's, for every
    test class in its method resolution order (a base class from another test module included)."""
    out: Dict[str, Set[str]] = {}
    for name in names:
        module_name, _, qual = name.partition(".")
        bases = [(module_name, qual.split(".")[0])]
        kind = getattr(sys.modules.get(module_name), qual.split(".")[0], None)
        if isinstance(kind, type):
            bases = [(k.__module__, k.__qualname__.split(".")[0]) for k in kind.__mro__
                     if (TESTS / f"{k.__module__}.py").is_file()] or bases
        out[name] = {node for module, cls in bases for node in (f"tests/{module}.py", f"tests/{module}.py::{cls}")}
    return out


def reaching(graph: Map, names: List[str], stands_for: Dict[str, Set[str]], changed_name: str) -> List[str]:
    """The classes that read this file, directly or through what they read, plus any the table names for it."""
    reached = graph.ancestors(changed_name) | {changed_name}
    hits = [cls for cls in names if stands_for[cls] & reached]
    for prefix, modules in TABLE.items():
        if changed_name.startswith(prefix):
            hits += [cls for cls in names if cls.split(".")[0] in modules and cls not in hits]
    return hits


def select(changed: List[str], graph: Optional[Map] = None) -> Tuple[Optional[str], Dict[str, str], List[str], List[str]]:
    """(why every class runs, or None; chosen class -> reason; changed files no test reads; every class)."""
    names, broken = in_parallel.classes()
    if broken:
        return ("a test module could not be loaded (" + ", ".join(sorted(broken))[:300] + ")", {}, [], names)
    for name in changed:
        if name in EVERYTHING:
            return (f"{name}: {EVERYTHING[name]}", {}, [], names)
        if name.startswith("tests/") and name.endswith(".py") and not test_module(name):
            return (f"{name}: a shared test helper changed", {}, [], names)
    graph = graph or Map()
    stands_for = class_nodes(names)
    chosen: Dict[str, str] = {}
    unread: List[str] = []
    for changed_name in changed:
        if changed_name in graph.unparsed and test_module(changed_name):
            return (f"{changed_name} cannot be parsed, so its classes are unknown", {}, [], names)
        hits = reaching(graph, names, stands_for, changed_name)
        if not hits:
            if changed_name.startswith(NOT_READ_BY_TESTS) or changed_name in NOT_READ_BY_TESTS_FILES:
                unread.append(changed_name)
                continue
            if test_module(changed_name) and not (ROOT / changed_name).exists():
                continue  # a test module that was deleted
            return (f"{changed_name}: no test or script names it, so what it affects is unknown", {}, [], names)
        if is_python(changed_name) and not test_module(changed_name) and len(hits) > MOST * len(names):
            return (f"{changed_name}: reached by {len(hits)} of {len(names)} classes", {}, [], names)
        own = PurePosixPath(changed_name).stem + "."
        for cls in hits:
            chosen.setdefault(cls, f"is in {changed_name}" if cls.startswith(own) and test_module(changed_name)
                              else f"reaches {changed_name}")
    return None, {cls: chosen[cls] for cls in names if cls in chosen}, unread, names


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("paths", nargs="*", help="changed files (default: this branch against main, plus uncommitted and untracked)")
    parser.add_argument("--list", action="store_true", help="print the chosen classes; run nothing")
    parser.add_argument("--why", action="store_true", help="say in one line why each class was chosen")
    parser.add_argument("-j", "--jobs", type=int, default=os.cpu_count() or 2, help="how many at a time")
    args = parser.parse_args(argv)

    if args.paths:
        changed = sorted({os.path.relpath(os.path.abspath(p), ROOT).replace(os.sep, "/") for p in args.paths})
    else:
        changed = changed_files()
    if not changed:
        print("No changed files: nothing to run.")
        return 0
    everything, chosen, unread, names = select(changed)
    if unread:
        print("No test reads " + ", ".join(unread) + ".")
    if everything:
        print(f"Running every class ({len(names)}): {everything}.")
        chosen = {name: "every class runs" for name in names}
    elif not chosen:
        print(f"No test class is affected by the {len(changed)} changed file(s): nothing to run.")
        return 0
    else:
        print(f"{len(chosen)} of {len(names)} classes are affected by the {len(changed)} changed file(s).")
    if args.list or args.why:
        for name, reason in chosen.items():
            print(f"  {name}" + (f"  ({reason})" if args.why and not everything else ""))
    if args.list:
        return 0
    return in_parallel.run(list(chosen), args.jobs)


if __name__ == "__main__":
    sys.exit(main())
