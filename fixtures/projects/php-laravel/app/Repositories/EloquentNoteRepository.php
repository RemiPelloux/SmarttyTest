<?php

namespace App\Repositories;

use App\Contracts\NoteRepository;
use App\Models\Note;

class EloquentNoteRepository implements NoteRepository
{
    public function create(string $body): Note
    {
        return Note::create(['body' => trim($body)]);
    }
}
