"""Prices in cents."""

VAT = 0.2


def with_vat(cents: int) -> int:
    return round(cents * (1 + VAT))


def discount(cents: int, percent: int) -> int:
    return cents - cents * percent // 100
