- New **Aurora (nowcast)** layer, keyless. NOAA SWPC's OVATION Prime model
  publishes a whole-globe aurora probability grid about every five minutes;
  the layer draws it as one ground-draped imagery tile rather than 65,160
  entities, so it costs one texture and no per-frame work. The ramp runs green
  through yellow to red and fades out at the quiet edge of the oval, and cells
  below 2% probability are fully transparent so the forecast reads as an oval
  instead of a haze over the night side. A refresh adds the replacement before
  removing what it replaces, so the oval does not blink, and the texture it
  replaces is destroyed with its layer. An incomplete or out-of-range grid is
  refused rather than drawn with holes. The layer reports the cells it actually
  draws, the peak probability, and both the observation and forecast times,
  because OVATION is a short-horizon forecast rather than an observation.
