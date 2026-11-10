"""MACH Next structural contracts. Not a Factory dispatch authorization layer."""


def validate_workspace(root):
    from .validate import validate_workspace as _validate_workspace
    return _validate_workspace(root)


def read_local_policy(root):
    from .validate import read_local_policy as _read_local_policy
    return _read_local_policy(root)


__all__ = ["validate_workspace", "read_local_policy"]
