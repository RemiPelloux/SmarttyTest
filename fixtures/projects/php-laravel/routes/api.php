<?php

use App\Http\Controllers\GreetingController;
use App\Http\Controllers\NoteController;
use Illuminate\Support\Facades\Route;

Route::get('/greet/{name}', [GreetingController::class, 'show']);
Route::post('/notes', [NoteController::class, 'store']);
