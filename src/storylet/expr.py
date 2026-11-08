"""Expression language for storylet conditions and effects.

The syntax is deliberately a superset of BioWare's conditional code (as found in the plot
databases) so that extracted conditionals can be lifted into storylets verbatim:

    expr     := or ( '?' expr ':' expr )?
    or       := and ( '||' and )*
    and      := not ( '&&' not )*
    not      := '!' not | cmp
    cmp      := sum ( ('=='|'!='|'<'|'<='|'>'|'>=') sum )?
    sum      := term ( ('+'|'-') term )*
    term     := unary ( ('*'|'/'|'%') unary )*
    unary    := '-' unary | atom
    atom     := NUMBER | 'true' | 'false' | STRING | NAME | NAME '(' args ')' | '(' expr ')'
    NAME     := dotted identifier, segments may be numeric (``me1.bool.3828``, ``me1.virmire.choice``)

Effects are statements ``target = expr``, ``target += expr``, ``target -= expr``.

Names are resolved by the caller through an ``env`` callback, so the language knows nothing
about plot tables; functions are looked up in a function table (see ``FUNCTIONS``).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Iterator

TOKEN_RE = re.compile(
    r"""\s*(?:
        (?P<num>\d+\.\d+|\d+)(?![A-Za-z_])
      | (?P<str>"[^"]*"|'[^']*')
      | (?P<name>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)
      | (?P<op>\+=|-=|==|!=|<=|>=|&&|\|\||[-+*/%<>!()=,?:])
    )""",
    re.X,
)


class ExprError(ValueError):
    pass


def tokenize(src: str) -> list[tuple[str, str]]:
    pos, out = 0, []
    src = src.rstrip()
    while pos < len(src):
        m = TOKEN_RE.match(src, pos)
        if not m or m.end() == pos:
            raise ExprError(f"unexpected input at {pos}: {src[pos:pos + 20]!r} in {src!r}")
        pos = m.end()
        kind = m.lastgroup
        out.append((kind, m.group(kind)))
    out.append(("end", ""))
    return out


# --- AST -------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Node:
    op: str           # 'lit', 'name', 'call', 'not', 'neg', binary op, '?:'
    args: tuple = ()
    value: Any = None

    def names(self) -> Iterator[str]:
        """Variable/condition names read; arguments of seen()/chose() are ids, not names."""
        if self.op == "name":
            yield self.value
        if self.op == "call" and self.value in SPECIAL_FORMS:
            return
        for a in self.args:
            yield from a.names()

    def calls(self) -> Iterator["Node"]:
        if self.op == "call":
            yield self
        for a in self.args:
            yield from a.calls()

    def __str__(self) -> str:  # canonical, re-parseable
        if self.op == "lit":
            v = self.value
            return ("true" if v else "false") if isinstance(v, bool) else (f'"{v}"' if isinstance(v, str) else str(v))
        if self.op == "name":
            return self.value
        if self.op == "call":
            return f"{self.value}({', '.join(map(str, self.args))})"
        if self.op == "not":
            return f"!{self.args[0]}"
        if self.op == "neg":
            return f"-{self.args[0]}"
        if self.op == "?:":
            return f"({self.args[0]} ? {self.args[1]} : {self.args[2]})"
        return f"({self.args[0]} {self.op} {self.args[1]})"


class Parser:
    def __init__(self, src: str):
        self.src = src
        self.toks = tokenize(src)
        self.i = 0

    def peek(self) -> tuple[str, str]:
        return self.toks[self.i]

    def take(self, value: str | None = None) -> tuple[str, str]:
        tok = self.toks[self.i]
        if value is not None and tok[1] != value:
            raise ExprError(f"expected {value!r}, got {tok[1]!r} in {self.src!r}")
        self.i += 1
        return tok

    def at(self, *values: str) -> bool:
        k, v = self.peek()
        return k == "op" and v in values

    def parse(self) -> Node:
        node = self.expr()
        if self.peek()[0] != "end":
            raise ExprError(f"trailing input {self.peek()[1]!r} in {self.src!r}")
        return node

    def expr(self) -> Node:
        cond = self.or_()
        if self.at("?"):
            self.take("?")
            a = self.expr()
            self.take(":")
            b = self.expr()
            return Node("?:", (cond, a, b))
        return cond

    def _binary(self, sub: Callable[[], Node], ops: tuple[str, ...]) -> Node:
        left = sub()
        while self.at(*ops):
            op = self.take()[1]
            left = Node(op, (left, sub()))
        return left

    def or_(self) -> Node:
        return self._binary(self.and_, ("||",))

    def and_(self) -> Node:
        return self._binary(self.not_, ("&&",))

    def not_(self) -> Node:
        if self.at("!"):
            self.take()
            return Node("not", (self.not_(),))
        return self.cmp()

    def cmp(self) -> Node:
        left = self.sum()
        if self.at("==", "!=", "<", "<=", ">", ">="):
            op = self.take()[1]
            left = Node(op, (left, self.sum()))
        return left

    def sum(self) -> Node:
        return self._binary(self.term, ("+", "-"))

    def term(self) -> Node:
        return self._binary(self.unary, ("*", "/", "%"))

    def unary(self) -> Node:
        if self.at("-"):
            self.take()
            return Node("neg", (self.unary(),))
        return self.atom()

    def atom(self) -> Node:
        kind, val = self.take()
        if kind == "num":
            return Node("lit", value=float(val) if "." in val else int(val))
        if kind == "str":
            return Node("lit", value=val[1:-1])
        if kind == "name":
            if val in ("true", "false"):
                return Node("lit", value=val == "true")
            if self.at("("):
                self.take("(")
                args = []
                if not self.at(")"):
                    args.append(self.expr())
                    while self.at(","):
                        self.take(",")
                        args.append(self.expr())
                self.take(")")
                return Node("call", tuple(args), val)
            return Node("name", value=val)
        if kind == "op" and val == "(":
            node = self.expr()
            self.take(")")
            return node
        raise ExprError(f"unexpected {val!r} in {self.src!r}")


_CACHE: dict[str, Node] = {}


def parse(src: str | bool | int | float) -> Node:
    if isinstance(src, bool):
        return Node("lit", value=src)
    if isinstance(src, (int, float)):
        return Node("lit", value=src)
    node = _CACHE.get(src)
    if node is None:
        node = _CACHE[src] = Parser(src).parse()
    return node


# --- evaluation ------------------------------------------------------------------------------
def _truthy(v: Any) -> bool:
    return bool(v)


FUNCTIONS: dict[str, Callable[..., Any]] = {
    "count": lambda *xs: sum(1 for x in xs if x),
    "sum": lambda *xs: sum(xs),
    "any": lambda *xs: any(xs),
    "all": lambda *xs: all(xs),
    "min": min,
    "max": max,
    "abs": abs,
    "int": int,
    "bool": bool,
}
# Functions whose arguments are storylet/choice ids, not expressions (evaluated by the engine).
SPECIAL_FORMS = {"seen", "chose", "total"}
# Any call that is neither a builtin nor a special form is delegated to the ``special`` callback
# (the engine uses this for lifted plot-database conditionals that take an ``argument``).


Env = Callable[[str], Any]


def evaluate(node: Node, env: Env, special: Callable[[Node], Any] | None = None) -> Any:
    op = node.op
    if op == "lit":
        return node.value
    if op == "name":
        return env(node.value)
    if op == "not":
        return not _truthy(evaluate(node.args[0], env, special))
    if op == "neg":
        return -evaluate(node.args[0], env, special)
    if op == "&&":
        return _truthy(evaluate(node.args[0], env, special)) and _truthy(evaluate(node.args[1], env, special))
    if op == "||":
        return _truthy(evaluate(node.args[0], env, special)) or _truthy(evaluate(node.args[1], env, special))
    if op == "?:":
        return evaluate(node.args[1] if _truthy(evaluate(node.args[0], env, special)) else node.args[2], env, special)
    if op == "call":
        fn = FUNCTIONS.get(node.value)
        if fn is None or node.value in SPECIAL_FORMS:
            if special is None:
                raise ExprError(f"unknown function {node.value}()")
            return special(node)
        return fn(*(evaluate(a, env, special) for a in node.args))
    a = evaluate(node.args[0], env, special)
    b = evaluate(node.args[1], env, special)
    if op == "==":
        return a == b
    if op == "!=":
        return a != b
    if op == "<":
        return a < b
    if op == "<=":
        return a <= b
    if op == ">":
        return a > b
    if op == ">=":
        return a >= b
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return a / b
    if op == "%":
        return a % b
    raise ExprError(f"bad op {op}")


# --- effects ---------------------------------------------------------------------------------
EFFECT_RE = re.compile(r"^\s*(?P<target>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*(?P<op>\+=|-=|=)(?!=)\s*(?P<expr>.+?)\s*$")


@dataclass(frozen=True)
class Effect:
    target: str
    op: str  # '=', '+=', '-='
    expr: Node
    src: str

    def __str__(self) -> str:
        return self.src


def parse_effect(src: str) -> Effect:
    m = EFFECT_RE.match(src)
    if not m:
        raise ExprError(f"bad effect {src!r}: expected 'target = expr' / '+=' / '-='")
    return Effect(m.group("target"), m.group("op"), parse(m.group("expr")), src.strip())
