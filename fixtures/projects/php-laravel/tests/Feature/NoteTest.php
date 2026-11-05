<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class NoteTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_stores_a_note_through_the_bound_repository(): void
    {
        $this->postJson('/api/notes', ['body' => '  remember  '])->assertCreated();
        $this->assertDatabaseHas('notes', ['body' => 'remember']);
    }
}
