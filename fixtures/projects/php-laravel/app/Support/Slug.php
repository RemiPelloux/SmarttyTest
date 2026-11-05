<?php

namespace App\Support;

final class Slug
{
    public static function make(string $text): string
    {
        return strtolower(trim((string) preg_replace('/[^A-Za-z0-9]+/', '-', $text), '-'));
    }
}
