# A frozen copy of all eight genres

`genres/` as it stood when this copy was taken. `tests/unit/lib/genre-pads.test.ts` starts
every genre in every layout against it. The main fixture (`tests/fixtures/repo`) holds only
two genres, older ones, which other tests rely on; this one is the whole set.

No test reads the real `genres/`, which are edited as the owner works. To take a fresh copy
after changing them on purpose, in a shell with `rm` and `cp`:

```sh
rm -rf tests/fixtures/defaults/genres
cp -r genres tests/fixtures/defaults/genres
```

Then check the real genres directly: `azeron lint` and `azeron defaults <genre>`.
