# Station artwork

Drop one SVG or PNG per station here and point `radioArtwork` in
[`config.js`](../config.js) at it, keyed by the station name exactly as OwnTone
reports it:

```js
radioArtwork: {
  'KEXP 90.3': 'station-logos/kexp.svg',
},
```

Stations without an entry get a monogram generated from the station name, so
this is entirely optional.

`example.svg` shows the shape the dashboard expects: a square viewBox with a
rounded corner radius, because the card crops artwork to a rounded square.
