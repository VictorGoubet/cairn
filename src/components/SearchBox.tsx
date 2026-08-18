import { useEffect, useRef, useState } from 'react';
import { formatCoordinates, parseCoordinates } from '../lib/coordinates';
import { type GeocodeResult, searchPlaces } from '../lib/geocode';
import { useT } from '../lib/i18n';
import { usePlanner } from '../store';

export function SearchBox() {
  const t = useT();
  // read inside the effect without making the translation a dependency of the search
  const tRef = useRef(t);
  tRef.current = t;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<number>(0);
  const skipSearchRef = useRef(false);

  useEffect(() => {
    if (skipSearchRef.current) {
      skipSearchRef.current = false;
      return;
    }
    window.clearTimeout(debounceRef.current);
    if (query.trim().length < 3) {
      setResults([]);
      setOpen(false);
      return;
    }
    // coordinates are answered locally: typing a cache listing must not wait on a geocoder
    // that would only shrug at "N 44 37.908 E 006 46.512"
    const typed = parseCoordinates(query);
    if (typed) {
      setResults([
        { name: formatCoordinates(typed), detail: tRef.current('coordinates'), lon: typed[0], lat: typed[1] },
      ]);
      setOpen(true);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      searchPlaces(query)
        .then(r => {
          setResults(r);
          setOpen(true);
        })
        .catch(() => setResults([]));
    }, 300);
    return () => window.clearTimeout(debounceRef.current);
  }, [query]);

  function select(result: GeocodeResult) {
    skipSearchRef.current = true;
    // the pin answers "where is it, and where do I click to use it": centering alone left the
    // spot invisible in the middle of a map
    usePlanner.getState().setSearchPin([result.lon, result.lat]);
    usePlanner.getState().setFlyTo({ center: [result.lon, result.lat], zoom: 13 });
    setQuery(result.name);
    setResults([]);
    setOpen(false);
  }

  /** the search doubles as a route builder: hop from place to place, or from cache to cache */
  function append(result: GeocodeResult) {
    usePlanner.getState().setSearchPin(null);
    usePlanner.getState().addAnchor([result.lon, result.lat]);
    usePlanner.getState().setFlyTo({ center: [result.lon, result.lat], zoom: 14 });
    setQuery('');
    setResults([]);
    setOpen(false);
  }

  return (
    <div className="search-box">
      <input
        type="search"
        placeholder={t('search_placeholder')}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => {
          if (e.key === 'Enter' && results[0]) select(results[0]);
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && results.length > 0 && (
        <ul className="search-results">
          {results.map(r => (
            <li key={`${r.lon},${r.lat},${r.name}`}>
              <button type="button" className="result-go" onMouseDown={() => select(r)}>
                <span className="result-name">{r.name}</span>
                <span className="result-detail">{r.detail}</span>
              </button>
              <button
                type="button"
                className="result-add"
                title={t('add_to_route')}
                aria-label={t('add_to_route')}
                onMouseDown={() => append(r)}
              >
                +
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
