"""Shared YAML loader, $include expander, and schema constants for e2e-dsl scripts."""

from pathlib import Path, PureWindowsPath

import yaml

VALID_PARTICIPANT_TYPES = {"actor", "frontend", "service", "external", "database", "queue"}
VALID_PROTOCOLS = {"http", "ws", "rpc", "event", "db"}
VALID_OUTCOMES = {"success", "rejected"}
UI_ACTION_KEYS = {"navigate", "click", "fill", "select", "expectVisible", "expectText"}
API_ACTION_KEYS = {"request", "expectResponse", "expectRecord"}
REALTIME_ACTION_KEYS = {"wsSend", "expectEvent"}
DB_ACTION_KEYS = {"expectRow"}
PRIMARY_ACTION_KEYS = UI_ACTION_KEYS | API_ACTION_KEYS | REALTIME_ACTION_KEYS | DB_ACTION_KEYS


class UniqueLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        mapping = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in mapping:
                raise ValueError(f"{key_node.start_mark}: non-string or duplicate key {key!r}")
            mapping[key] = self.construct_object(value_node, deep=deep)
        return mapping


def require(condition, message):
    if not condition:
        raise ValueError(message)


class Bundle:
    def __init__(self, root: Path):
        self.root = root.resolve(strict=True)

    def path(self, directory: Path, reference: str, suffixes: set[str], must_exist: bool = True) -> Path:
        require(isinstance(reference, str) and reference, "expected a non-empty relative file path")
        path = Path(reference)
        windows = PureWindowsPath(reference)
        require(not path.is_absolute() and not windows.anchor, f"absolute path not allowed: {reference!r}")
        if suffixes:
            require(path.suffix in suffixes, f"unexpected extension in {reference!r}")
        target = (directory / path).resolve(strict=must_exist)
        require(target.is_relative_to(self.root), f"path escapes bundle root: {reference!r}")
        if must_exist:
            require(target.is_file(), f"expected file: {reference!r}")
        return target

    def yaml(self, path: Path, chain=()):
        require(path not in chain, f"include cycle: {' -> '.join(p.name for p in (*chain, path))}")
        try:
            with path.open(encoding="utf-8") as stream:
                node = yaml.load(stream, Loader=UniqueLoader)
            return self.expand(node, path, (*chain, path))
        except (ValueError, yaml.YAMLError, OSError, RuntimeError) as error:
            raise ValueError(f"{path.relative_to(self.root)}: {error}") from error

    def expand(self, node, path: Path, chain, parents=frozenset()):
        if not isinstance(node, (dict, list)):
            return node
        require(id(node) not in parents, "recursive YAML alias")
        parents = parents | {id(node)}
        if isinstance(node, list):
            return [self.expand(value, path, chain, parents) for value in node]
        if "$include" in node:
            require(len(node) == 1, "$include cannot have sibling keys")
            fragment = self.path(path.parent, node["$include"], {".yaml", ".yml"})
            result = self.yaml(fragment, chain)
            require(isinstance(result, (dict, list)), "$include must yield a mapping or list")
            return result
        return {key: self.expand(value, path, chain, parents) for key, value in node.items()}

    def document(self, directory: Path, reference: str, kind: str):
        path = self.path(directory, reference, {".yaml", ".yml"})
        node = self.yaml(path)
        require(
            isinstance(node, dict) and node.get("kind") == kind and node.get("id"),
            f"{reference}: expected kind {kind!r} and a non-empty 'id'",
        )
        return path, node


def load_suite(bundle_dir: Path):
    bundle = Bundle(bundle_dir)
    suite_path, suite = bundle.document(bundle.root, "e2e.suite.yaml", "E2ESuite")
    require(suite.get("dslVersion") == 1, "expected dslVersion: 1")
    fixture_ref = suite["environment"]["database"]["fixtures"]
    _, fixtures = bundle.document(suite_path.parent, fixture_ref, "E2EFixtures")
    return bundle, suite, fixtures


def iter_scenarios(suite: dict):
    suites = suite.get("suites", {})
    require(isinstance(suites, dict) and suites, "suites must be a non-empty mapping")
    for suite_name, cases in suites.items():
        require(isinstance(cases, list), f"suite {suite_name!r} must be a list of scenarios")
        for case in cases:
            yield suite_name, case
