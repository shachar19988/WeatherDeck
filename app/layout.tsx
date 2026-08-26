import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'WeatherDeck — Personal Forecast Console',
  description: 'Multi-model wind, weather, and marine forecasts for Haifa.',
  manifest: '/manifest.webmanifest',
  themeColor: '#07171f',
  openGraph: {
    title: 'WeatherDeck',
    description: 'Wind. Weather. Marine.',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'WeatherDeck',
    description: 'Wind. Weather. Marine.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
