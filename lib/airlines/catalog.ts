/**
 * Client-safe airline directory for places that only have an IATA carrier code.
 * Unknown carriers deliberately remain supported by the manual-import fallback.
 */
export const AIRLINE_CATALOG = [
  // ============================================================
  // BANGLADESH
  // ============================================================
  { code: 'BG', name: 'Biman Bangladesh Airlines' },
  { code: 'BS', name: 'US-Bangla Airlines' },
  { code: '2A', name: 'Air Astra' },
  { code: 'VQ', name: 'Novoair' },

  // ============================================================
  // INDIA / SOUTH ASIA
  // ============================================================
  { code: 'AI', name: 'Air India' },
  { code: 'IX', name: 'Air India Express' },
  { code: '6E', name: 'IndiGo' },
  { code: 'QP', name: 'Akasa Air' },
  { code: 'SG', name: 'SpiceJet' },
  { code: 'UL', name: 'SriLankan Airlines' },
  { code: 'PK', name: 'Pakistan International Airlines' },
  { code: 'PA', name: 'Airblue' },
  { code: 'RA', name: 'Nepal Airlines' },
  { code: 'H9', name: 'Himalaya Airlines' },
  { code: 'Q2', name: 'Maldivian' },
  { code: 'KB', name: 'Drukair' },

  // ============================================================
  // MIDDLE EAST / GULF
  // ============================================================
  { code: 'EK', name: 'Emirates' },
  { code: 'QR', name: 'Qatar Airways' },
  { code: 'EY', name: 'Etihad Airways' },
  { code: 'SV', name: 'Saudia' },
  { code: 'FZ', name: 'flydubai' },
  { code: 'G9', name: 'Air Arabia' },
  { code: '3L', name: 'Air Arabia Abu Dhabi' },
  { code: 'GF', name: 'Gulf Air' },
  { code: 'WY', name: 'Oman Air' },
  { code: 'OV', name: 'SalamAir' },
  { code: 'KU', name: 'Kuwait Airways' },
  { code: 'J9', name: 'Jazeera Airways' },
  { code: 'XY', name: 'flynas' },
  { code: 'F3', name: 'flyadeal' },
  { code: 'RJ', name: 'Royal Jordanian' },
  { code: 'LY', name: 'EL AL Israel Airlines' },
  { code: 'IZ', name: 'Arkia Israeli Airlines' },
  { code: '6H', name: 'Israir' },

  // ============================================================
  // SOUTHEAST ASIA
  // ============================================================
  { code: 'SQ', name: 'Singapore Airlines' },
  { code: 'TR', name: 'Scoot' },
  { code: 'MH', name: 'Malaysia Airlines' },
  { code: 'AK', name: 'AirAsia' },
  { code: 'D7', name: 'AirAsia X' },
  { code: 'OD', name: 'Batik Air Malaysia' },
  { code: 'ID', name: 'Batik Air' },
  { code: 'TG', name: 'Thai Airways' },
  { code: 'FD', name: 'Thai AirAsia' },
  { code: 'SL', name: 'Thai Lion Air' },
  { code: 'PG', name: 'Bangkok Airways' },
  { code: 'VN', name: 'Vietnam Airlines' },
  { code: 'VJ', name: 'VietJet Air' },
  { code: 'K6', name: 'Air Cambodia' },
  { code: 'QV', name: 'Lao Airlines' },
  { code: '8M', name: 'Myanmar Airways International' },
  { code: 'UB', name: 'Myanmar National Airlines' },
  { code: 'PR', name: 'Philippine Airlines' },
  { code: '5J', name: 'Cebu Pacific' },
  { code: 'Z2', name: 'Philippines AirAsia' },
  { code: 'GA', name: 'Garuda Indonesia' },
  { code: 'QG', name: 'Citilink' },
  { code: 'JT', name: 'Lion Air' },
  { code: 'BI', name: 'Royal Brunei Airlines' },

  // ============================================================
  // CHINA / HONG KONG / MACAU / TAIWAN
  // ============================================================
  { code: 'CA', name: 'Air China' },
  { code: 'CZ', name: 'China Southern Airlines' },
  { code: 'MU', name: 'China Eastern Airlines' },
  { code: 'MF', name: 'XiamenAir' },
  { code: 'HU', name: 'Hainan Airlines' },
  { code: '3U', name: 'Sichuan Airlines' },
  { code: 'ZH', name: 'Shenzhen Airlines' },
  { code: 'HO', name: 'Juneyao Airlines' },
  { code: 'GS', name: 'Tianjin Airlines' },
  { code: 'JD', name: 'Beijing Capital Airlines' },
  { code: 'SC', name: 'Shandong Airlines' },
  { code: 'FM', name: 'Shanghai Airlines' },
  { code: 'G5', name: 'China Express Airlines' },
  { code: 'KN', name: 'China United Airlines' },
  { code: '9C', name: 'Spring Airlines' },
  { code: 'BK', name: 'Okay Airways' },
  { code: 'GT', name: 'Air Guilin' },
  { code: '9H', name: 'Air Changan' },
  { code: 'DR', name: 'Ruili Airlines' },
  { code: 'QW', name: 'Qingdao Airlines' },
  { code: 'EU', name: 'Chengdu Airlines' },
  { code: 'FU', name: 'Fuzhou Airlines' },
  { code: 'GX', name: 'GX Airlines' },
  { code: 'CX', name: 'Cathay Pacific' },
  { code: 'HX', name: 'Hong Kong Airlines' },
  { code: 'UO', name: 'HK Express' },
  { code: 'NX', name: 'Air Macau' },
  { code: 'CI', name: 'China Airlines' },
  { code: 'BR', name: 'EVA Air' },
  { code: 'JX', name: 'STARLUX Airlines' },

  // ============================================================
  // JAPAN / SOUTH KOREA
  // ============================================================
  { code: 'JL', name: 'Japan Airlines' },
  { code: 'NH', name: 'All Nippon Airways' },
  { code: 'MM', name: 'Peach Aviation' },
  { code: 'GK', name: 'Jetstar Japan' },
  { code: 'NU', name: 'Japan Transocean Air' },
  { code: 'KE', name: 'Korean Air' },
  { code: 'OZ', name: 'Asiana Airlines' },
  { code: '7C', name: 'Jeju Air' },
  { code: 'LJ', name: 'Jin Air' },
  { code: 'TW', name: 'T’way Air' },
  { code: 'ZE', name: 'Eastar Jet' },
  { code: 'YP', name: 'Air Premia' },

  // ============================================================
  // CENTRAL ASIA / CAUCASUS
  // ============================================================
  { code: 'KC', name: 'Air Astana' },
  { code: 'IQ', name: 'Qazaq Air' },
  { code: 'HY', name: 'Uzbekistan Airways' },
  { code: 'J2', name: 'Azerbaijan Airlines' },
  { code: 'A9', name: 'Georgian Airways' },
  { code: '4L', name: 'Georgian Airways' },
  { code: 'WZ', name: 'Red Wings Airlines' },

  // ============================================================
  // TURKEY
  // ============================================================
  { code: 'TK', name: 'Turkish Airlines' },
  { code: 'PC', name: 'Pegasus Airlines' },
  { code: 'VF', name: 'AJet' },
  { code: 'XC', name: 'Corendon Airlines' },
  { code: 'FH', name: 'Freebird Airlines' },

  // ============================================================
  // UNITED KINGDOM / IRELAND
  // ============================================================
  { code: 'BA', name: 'British Airways' },
  { code: 'VS', name: 'Virgin Atlantic' },
  { code: 'U2', name: 'easyJet' },
  { code: 'LS', name: 'Jet2.com' },
  { code: 'EI', name: 'Aer Lingus' },
  { code: 'FR', name: 'Ryanair' },

  // ============================================================
  // WESTERN / CENTRAL EUROPE
  // ============================================================
  { code: 'LH', name: 'Lufthansa' },
  { code: 'AF', name: 'Air France' },
  { code: 'KL', name: 'KLM Royal Dutch Airlines' },
  { code: 'LX', name: 'SWISS' },
  { code: 'OS', name: 'Austrian Airlines' },
  { code: 'SN', name: 'Brussels Airlines' },
  { code: 'AZ', name: 'ITA Airways' },
  { code: 'IB', name: 'Iberia' },
  { code: 'UX', name: 'Air Europa' },
  { code: 'TP', name: 'TAP Air Portugal' },
  { code: 'AY', name: 'Finnair' },
  { code: 'LO', name: 'LOT Polish Airlines' },
  { code: 'SK', name: 'SAS' },
  { code: 'A3', name: 'Aegean Airlines' },
  { code: 'RO', name: 'TAROM' },
  { code: 'OU', name: 'Croatia Airlines' },
  { code: 'JU', name: 'Air Serbia' },
  { code: 'FB', name: 'Bulgaria Air' },
  { code: 'BT', name: 'airBaltic' },
  { code: 'FI', name: 'Icelandair' },
  { code: 'KM', name: 'KM Malta Airlines' },

  // ============================================================
  // EUROPE LOW-COST / LEISURE
  // ============================================================
  { code: 'W6', name: 'Wizz Air' },
  { code: 'EW', name: 'Eurowings' },
  { code: 'VY', name: 'Vueling' },
  { code: 'TO', name: 'Transavia France' },
  { code: 'HV', name: 'Transavia' },
  { code: 'DE', name: 'Condor' },
  { code: '4Y', name: 'Discover Airlines' },
  { code: 'XQ', name: 'SunExpress' },
  { code: 'NO', name: 'Neos' },
  { code: 'BJ', name: 'Nouvelair' },
  { code: 'BF', name: 'French Bee' },
  { code: 'SS', name: 'Corsair International' },
  { code: 'XZ', name: 'Aeroitalia' },
  { code: 'CY', name: 'Cyprus Airways' },
  { code: 'GQ', name: 'SKY express' },

  // ============================================================
  // EASTERN EUROPE / EURASIA
  // ============================================================
  { code: 'SU', name: 'Aeroflot' },
  { code: 'S7', name: 'S7 Airlines' },
  { code: 'FV', name: 'Rossiya Airlines' },
  { code: 'N4', name: 'Nordwind Airlines' },
  { code: 'Y7', name: 'NordStar' },
  { code: 'B2', name: 'Belavia' },

  // ============================================================
  // USA
  // ============================================================
  { code: 'AA', name: 'American Airlines' },
  { code: 'DL', name: 'Delta Air Lines' },
  { code: 'UA', name: 'United Airlines' },
  { code: 'B6', name: 'JetBlue Airways' },
  { code: 'AS', name: 'Alaska Airlines' },
  { code: 'HA', name: 'Hawaiian Airlines' },
  { code: 'WN', name: 'Southwest Airlines' },
  { code: 'F9', name: 'Frontier Airlines' },
  { code: 'NK', name: 'Spirit Airlines' },
  { code: 'G4', name: 'Allegiant Air' },
  { code: 'SY', name: 'Sun Country Airlines' },

  // ============================================================
  // CANADA
  // ============================================================
  { code: 'AC', name: 'Air Canada' },
  { code: 'WS', name: 'WestJet' },
  { code: 'TS', name: 'Air Transat' },
  { code: 'PD', name: 'Porter Airlines' },
  { code: 'F8', name: 'Flair Airlines' },
  { code: '5T', name: 'Canadian North' },

  // ============================================================
  // MEXICO / CENTRAL AMERICA / CARIBBEAN
  // ============================================================
  { code: 'AM', name: 'Aeromexico' },
  { code: 'Y4', name: 'Volaris' },
  { code: 'VB', name: 'Viva' },
  { code: 'CM', name: 'Copa Airlines' },
  { code: 'AV', name: 'Avianca' },
  { code: 'BW', name: 'Caribbean Airlines' },
  { code: 'UP', name: 'Bahamasair' },
  { code: 'WM', name: 'Winair' },
  { code: '5U', name: 'TAG Airlines' },

  // ============================================================
  // SOUTH AMERICA
  // ============================================================
  { code: 'LA', name: 'LATAM Airlines' },
  { code: 'AR', name: 'Aerolineas Argentinas' },
  { code: 'G3', name: 'GOL Linhas Aereas' },
  { code: 'AD', name: 'Azul Brazilian Airlines' },
  { code: 'H2', name: 'SKY Airline' },
  { code: 'JA', name: 'JetSMART' },
  { code: 'P5', name: 'Wingo' },
  { code: 'OB', name: 'Boliviana de Aviacion' },
  { code: 'ZP', name: 'Paranair' },

  // ============================================================
  // AUSTRALIA
  // ============================================================
  { code: 'QF', name: 'Qantas' },
  { code: 'VA', name: 'Virgin Australia' },
  { code: 'JQ', name: 'Jetstar Airways' },
  { code: 'ZL', name: 'Rex Airlines' },
  { code: 'FC', name: 'Link Airways' },

  // ============================================================
  // NEW ZEALAND / PACIFIC
  // ============================================================
  { code: 'NZ', name: 'Air New Zealand' },
  { code: 'FJ', name: 'Fiji Airways' },
  { code: 'PX', name: 'Air Niugini' },
  { code: 'SB', name: 'Aircalin' },
  { code: 'TN', name: 'Air Tahiti Nui' },
  { code: 'VT', name: 'Air Tahiti' },
  { code: 'IE', name: 'Solomon Airlines' },
  { code: 'NF', name: 'Air Vanuatu' },

  // ============================================================
  // NORTH / EAST AFRICA
  // ============================================================
  { code: 'ET', name: 'Ethiopian Airlines' },
  { code: 'KQ', name: 'Kenya Airways' },
  { code: 'MS', name: 'EgyptAir' },
  { code: 'SM', name: 'Air Cairo' },
  { code: 'NP', name: 'Nile Air' },
  { code: 'AH', name: 'Air Algerie' },
  { code: 'TU', name: 'Tunisair' },
  { code: 'AT', name: 'Royal Air Maroc' },
  { code: 'WB', name: 'RwandAir' },
  { code: 'TC', name: 'Air Tanzania' },
  { code: 'UR', name: 'Uganda Airlines' },

  // ============================================================
  // SOUTHERN AFRICA / INDIAN OCEAN
  // ============================================================
  { code: 'SA', name: 'South African Airways' },
  { code: '4Z', name: 'Airlink' },
  { code: 'FA', name: 'FlySafair' },
  { code: 'MK', name: 'Air Mauritius' },
  { code: 'HM', name: 'Air Seychelles' },
  { code: 'UU', name: 'Air Austral' },

  // ============================================================
  // WEST / CENTRAL AFRICA
  // ============================================================
  { code: 'KP', name: 'ASKY Airlines' },
  { code: 'P4', name: 'Air Peace' },
  { code: 'AW', name: 'Africa World Airlines' },
  { code: 'HC', name: 'Air Senegal' },
  { code: 'QC', name: 'Camair-Co' },
  { code: 'DT', name: 'TAAG Angola Airlines' },
  { code: 'HF', name: 'Air Cote d’Ivoire' },

  // ============================================================
  // ADDITIONAL EUROPEAN / REGIONAL
  // ============================================================
  { code: 'EN', name: 'Air Dolomiti' },
  { code: 'WX', name: 'CityJet' },
  { code: 'LG', name: 'Luxair' },
  { code: 'NT', name: 'Binter Canarias' },
  { code: 'SP', name: 'SATA Air Acores' },
  { code: 'S4', name: 'Azores Airlines' },
  { code: 'XK', name: 'Air Corsica' },
  { code: 'OA', name: 'Olympic Air' },
  { code: '4O', name: 'Air Montenegro' },
  { code: 'RC', name: 'Atlantic Airways' },
  { code: 'GL', name: 'Air Greenland' },
  { code: 'WK', name: 'Edelweiss Air' },

  // ============================================================
  // ADDITIONAL ASIA / REGIONAL / LOW COST
  // ============================================================
  { code: 'HB', name: 'Greater Bay Airlines' },
  { code: 'WE', name: 'Thai Smile' },
  { code: 'DD', name: 'Nok Air' },
  { code: 'IW', name: 'Wings Air' },
  { code: 'QZ', name: 'Indonesia AirAsia' },
  { code: 'IU', name: 'Super Air Jet' },
  { code: '8B', name: 'TransNusa' },
  { code: 'SJ', name: 'Sriwijaya Air' },

  // ============================================================
  // ADDITIONAL MIDDLE EAST / ASIA
  // ============================================================
  { code: 'IR', name: 'Iran Air' },
  { code: 'EP', name: 'Iran Aseman Airlines' },
  { code: 'B9', name: 'Iran Airtour' },
  { code: 'W5', name: 'Mahan Air' },
  { code: 'JS', name: 'Air Koryo' },

  // ============================================================
  // ADDITIONAL AFRICAN / REGIONAL
  // ============================================================
  { code: 'BP', name: 'Air Botswana' },
  { code: 'TM', name: 'LAM Mozambique Airlines' },
  { code: 'PW', name: 'Precision Air' },
  { code: 'FN', name: 'Fastjet Zimbabwe' },
  { code: 'SW', name: 'Air Namibia' },
  { code: '5Z', name: 'CemAir' },
  { code: 'P0', name: 'Proflight Zambia' },

  // ============================================================
  // ADDITIONAL AMERICAS
  // ============================================================
  { code: 'PY', name: 'Surinam Airways' },
  { code: 'TA', name: 'TACA' },
  { code: 'PZ', name: 'LATAM Paraguay' },
  { code: 'XL', name: 'LATAM Ecuador' },
  { code: '4C', name: 'LATAM Colombia' },
  { code: 'LP', name: 'LATAM Peru' },
  { code: '2K', name: 'Avianca Ecuador' },
  { code: 'LR', name: 'Avianca Costa Rica' },

  // ============================================================
  // MORE INTERNATIONAL / LEISURE / CONNECTING CARRIERS
  // ============================================================
  { code: 'TX', name: 'Air Caraibes' },
  { code: 'I2', name: 'Iberia Express' },
  { code: 'V7', name: 'Volotea' },
  { code: 'QS', name: 'Smartwings' },
  { code: 'DY', name: 'Norwegian' },
] as const;

const AIRLINE_NAMES: ReadonlyMap<string, string> = new Map(
  AIRLINE_CATALOG.map((airline) => [airline.code, airline.name]),
);

export function airlineNameForCode(code: string): string | null {
  return AIRLINE_NAMES.get(code.trim().toUpperCase()) ?? null;
}
