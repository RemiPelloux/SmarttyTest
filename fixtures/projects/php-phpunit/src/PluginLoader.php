<?php

declare(strict_types=1);

namespace Shop;

final class PluginLoader
{
    /** A class named at run time: SmartTest cannot tell which one. */
    public function load(string $class): object
    {
        return new $class();
    }
}
