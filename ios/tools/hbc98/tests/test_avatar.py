from __future__ import annotations

import unittest

from ios.tools.build_ios_126_recipe import (
    CHAT_AVATAR_DEFAULT_STATIC_INDEX,
    CHAT_AVATAR_FUNCTION,
    CHAT_AVATAR_LIVE_INDEX,
    CHAT_AVATAR_LOAD_OFFSET,
    assert_chat_avatar_motion,
    enable_chat_avatar_motion,
)
from ios.tools import build_ios_127_recipe
from ios.tools import build_ios_128_recipe


class ChatAvatarMotionTests(unittest.TestCase):
    def test_patch_requires_the_pinned_stock_bundle(self):
        # The mutation is deliberately based on semantic checks in the function
        # body rather than a raw byte replacement. A complete pinned fixture is
        # exercised by the recipe builder's pinned-input integration tests.
        self.assertEqual(CHAT_AVATAR_FUNCTION, 40727)
        self.assertEqual(CHAT_AVATAR_DEFAULT_STATIC_INDEX, 16147)
        self.assertEqual(CHAT_AVATAR_LIVE_INDEX, 17658)
        self.assertEqual(CHAT_AVATAR_LOAD_OFFSET, 52)
        self.assertTrue(callable(enable_chat_avatar_motion))
        self.assertTrue(callable(assert_chat_avatar_motion))

    def test_127_chat_avatar_pins(self):
        self.assertEqual(build_ios_127_recipe.CHAT_AVATAR_FUNCTION, 42779)
        self.assertEqual(build_ios_127_recipe.CHAT_AVATAR_DEFAULT_STATIC_INDEX, 13630)
        self.assertEqual(build_ios_127_recipe.CHAT_AVATAR_LIVE_INDEX, 15025)
        self.assertEqual(build_ios_127_recipe.CHAT_AVATAR_LOAD_OFFSET, 52)
        self.assertTrue(callable(build_ios_127_recipe.enable_chat_avatar_motion))
        self.assertTrue(callable(build_ios_127_recipe.assert_chat_avatar_motion))

    def test_128_chat_avatar_pins(self):
        self.assertEqual(build_ios_128_recipe.CHAT_AVATAR_FUNCTION, 43388)
        self.assertEqual(build_ios_128_recipe.CHAT_AVATAR_DEFAULT_STATIC_INDEX, 13623)
        self.assertEqual(build_ios_128_recipe.CHAT_AVATAR_LIVE_INDEX, 12891)
        self.assertEqual(build_ios_128_recipe.CHAT_AVATAR_LOAD_OFFSET, 52)
        self.assertFalse(hasattr(build_ios_128_recipe, 'enable_chat_avatar_motion'))
        self.assertTrue(callable(build_ios_128_recipe.assert_chat_avatar_static))


if __name__ == '__main__':
    unittest.main()
