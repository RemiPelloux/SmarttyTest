import unittest

from app.offer import build


class BuildTest(unittest.TestCase):
    def test_slug(self) -> None:
        self.assertEqual(build("Data Engineer")["slug"], "data-engineer")

    def test_name(self) -> None:
        self.assertEqual(build("X")["name"], "X")
