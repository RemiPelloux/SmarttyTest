<?php

namespace App\Http\Controllers;

use App\Contracts\NoteRepository;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class NoteController extends Controller
{
    public function store(Request $request, NoteRepository $notes): JsonResponse
    {
        $note = $notes->create((string) $request->input('body'));

        return response()->json(['id' => $note->id], 201);
    }
}
