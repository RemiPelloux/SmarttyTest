<?php

namespace Tests\Feature;

use Tests\TestCase;

class GreetingTest extends TestCase
{
    public function test_it_greets_through_the_facade(): void
    {
        $this->getJson('/api/greet/Ada')->assertOk()->assertJson(['message' => 'Hello, Ada!']);
    }
}
