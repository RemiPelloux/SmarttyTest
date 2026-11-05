<?php

namespace App\Facades;

use Illuminate\Support\Facades\Facade;

/** @method static string greet(string $name) */
class Greeter extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return 'greeter';
    }
}
