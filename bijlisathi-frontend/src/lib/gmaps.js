// Launch real turn-by-turn driving guidance in the Google Maps app via its
// universal-link URL. origin/destination are [lat, lng] pairs on the map.
export function openGoogleMapsRoute(origin, destination) {
  const params = new URLSearchParams({
    api: 1,
    origin: `${origin[0]},${origin[1]}`,
    destination: `${destination[0]},${destination[1]}`,
    travelmode: 'driving',
    dir_action: 'navigate',
  });
  const url = `https://www.google.com/maps/dir/?${params.toString()}`;
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { try { a.remove(); } catch {} }, 800);
}