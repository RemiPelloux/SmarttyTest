<?php

namespace App\Providers;

use App\Contracts\NoteRepository;
use App\Repositories\EloquentNoteRepository;
use App\Services\Greeter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton('greeter', fn () => new Greeter((string) config('app.greeting')));
        $this->app->bind(NoteRepository::class, EloquentNoteRepository::class);
    }

    public function boot(): void
    {
        //
    }
}
