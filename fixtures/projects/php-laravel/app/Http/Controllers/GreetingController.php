<?php

namespace App\Http\Controllers;

use App\Facades\Greeter;
use Illuminate\Http\JsonResponse;

class GreetingController extends Controller
{
    public function show(string $name): JsonResponse
    {
        return response()->json(['message' => Greeter::greet($name)]);
    }
}
