import unittest

from app.text import title


class TitleTest(unittest.TestCase):
    def test_title(self) -> None:
        self.assertEqual(title("hello world"), "Hello World")
