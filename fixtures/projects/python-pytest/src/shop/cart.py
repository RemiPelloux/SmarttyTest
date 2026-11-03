from shop.prices import with_vat


class Cart:
    def __init__(self) -> None:
        self.items: list[int] = []

    def add(self, cents: int) -> "Cart":
        self.items.append(cents)
        return self

    def total(self) -> int:
        return sum(with_vat(c) for c in self.items)
