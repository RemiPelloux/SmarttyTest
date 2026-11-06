<?php

namespace App\Contracts;

use App\Models\Note;

interface NoteRepository
{
    public function create(string $body): Note;
}
