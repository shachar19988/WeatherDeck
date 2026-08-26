import React from 'react';
import ReactDOM from 'react-dom/client';
import WeatherApp from '../app/weather-app';
import '../app/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><WeatherApp /></React.StrictMode>,
);
