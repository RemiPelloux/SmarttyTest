<?php

namespace App\Services;

class Greeter
{
    public function __construct(private string $greeting)
    {
    }

    public function greet(string $name): string
    {
        return $this->greeting.', '.$name.'!';
    }
}
