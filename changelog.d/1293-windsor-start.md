- A fresh session now opens over Windsor, Ontario instead of Austin, Texas.
  The startup flight faces roughly north, which from the Windsor riverfront
  looks straight across the Detroit River at the Detroit skyline. The
  coordinates live in one place, `STARTUP_LOCATION` in `src/camera.js`, and
  `flyToAustin` is renamed `flyToStartupLocation` so the function no longer
  names a city it does not fly to. The loading line is parameterized
  (`Flying to {place}...`) rather than hardcoding a place name per locale.
