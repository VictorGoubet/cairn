import { useEffect, useRef, useState } from 'react';
import { type GeocodeResult, searchPlaces } from '../lib/geocode';
import { useT } from '../lib/i18n';
import { usePlanner } from '../store';

export function SearchBox() {
  const t = useT();
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
    usePlanner.getState().setFlyTo({ center: [result.lon, result.lat], zoom: 13 });
    setQuery(result.name);
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
              <button type="button" onMouseDown={() => select(r)}>
                <span className="result-name">{r.name}</span>
                <span className="result-detail">{r.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
