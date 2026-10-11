/**
 * Client-safe commercial directory for LCC service margins.
 * Coverage reviewed: 2026-10-11. Includes the established app LCC examples
 * (including flydubai's hybrid offering) and separately coded subsidiaries.
 * An unknown carrier is not inferred to be LCC merely because net equals gross;
 * the markup rule's explicit lccServiceMargin flag remains the manual fallback.
 *
 * Classification/code references:
 * https://www.icao.int/sustainability/Documents/LCC-List.pdf
 *   Historical classification baseline only (2017); obsolete/closed carriers
 *   and obsolete codes are deliberately not imported from that list.
 * https://www.iata.org/en/iata-repository/publications/economic-reports/one-size-does-not-fit-all---airline-business-models/
 * https://www.iata.org/en/about/members/airline-list/akasa-air/662/
 * https://support.airasia.com/s/article/What-travel-documents-do-I-need-en?language=en_GB
 * https://www.airarabia.com/en/about-us/conditions-of-carriage
 * https://press.airarabia.com/air-arabia-abu-dhabi-adds-aleppo-to-its-growing-network-in-syria/
 * https://www.go.flyarystan.com/tpost/3x6slz8bb1-flyarystan-announces-new-iata-code-fs-fo
 * https://www.jal.com/en-jp/about/lcc/
 * https://www.airbus.com/en/about-us/our-worldwide-presence/airbus-in-asia-pacific/airbus-in-south-korea
 * https://help.ryanair.com/hc/en-mt/articles/12890911974289-General-Terms-Conditions-of-Carriage
 * https://jetsmart.com/ar/es/PreguntasFrecuentes/
 * https://cms.volaris.com/es/informacion-del-sitio/informacion-legal-volaris/
 * https://flynorse.com/assets/docs/Conditions-of-Carriage.pdf
 * https://ir.suncountry.com/news-releases/news-release-details/sun-country-airlines-extends-schedule-through-winter-and-0
 * https://services.boeing.com/resources/case-studies/data-driven-cbta-culture-safety-data-analytics
 * https://corporate.kenya-airways.com/globalassets/corporate/investment--shareholders/annual-reports/2025/annual-report-fy24.pdf
 * https://corporate.spicejet.com/CorporateOverview.aspx
 * https://www.jetstar.com/au/en/jetstar-asia-information
 *   JQ/GK remain active; 3K permanently ceased operations in July 2025.
 *
 * Do not substitute parent codes for subsidiaries (e.g. KC is Air Astana,
 * while FS is FlyArystan; JL is Japan Airlines, while ZG is ZIPAIR).
 */
export const LCC_AIRLINES = [
  // India / South Asia.
  { code: '6E', name: 'IndiGo' },
  { code: 'IX', name: 'Air India Express' },
  { code: 'QP', name: 'Akasa Air' },
  { code: 'SG', name: 'SpiceJet' },

  // Middle East / North Africa.
  { code: 'FZ', name: 'flydubai' },
  { code: 'G9', name: 'Air Arabia' },
  { code: '3L', name: 'Air Arabia Abu Dhabi' },
  { code: '3O', name: 'Air Arabia Maroc' },
  { code: 'E5', name: 'Air Arabia Egypt' },
  { code: 'OV', name: 'SalamAir' },
  { code: 'J9', name: 'Jazeera Airways' },
  { code: 'XY', name: 'flynas' },
  { code: 'F3', name: 'flyadeal' },
  { code: 'SM', name: 'Air Cairo' },

  // AirAsia group. I5 was merged into Air India Express (IX).
  { code: 'AK', name: 'AirAsia' },
  { code: 'D7', name: 'AirAsia X' },
  { code: 'FD', name: 'Thai AirAsia' },
  { code: 'QZ', name: 'Indonesia AirAsia' },
  { code: 'Z2', name: 'Philippines AirAsia' },
  { code: 'XJ', name: 'Thai AirAsia X' },
  { code: 'KT', name: 'AirAsia Cambodia' },

  // Other Southeast Asian LCCs.
  { code: 'TR', name: 'Scoot' },
  { code: 'SL', name: 'Thai Lion Air' },
  { code: 'VJ', name: 'VietJet Air' },
  { code: 'VZ', name: 'Thai Vietjet Air' },
  { code: '5J', name: 'Cebu Pacific' },
  { code: 'DG', name: 'Cebgo' },
  { code: 'QG', name: 'Citilink' },
  { code: 'JT', name: 'Lion Air' },
  { code: 'IW', name: 'Wings Air' },
  { code: 'IU', name: 'Super Air Jet' },
  { code: 'DD', name: 'Nok Air' },

  // China / Hong Kong / Taiwan.
  { code: '9C', name: 'Spring Airlines' },
  { code: 'KN', name: 'China United Airlines' },
  { code: 'PN', name: 'West Air' },
  { code: '8L', name: 'Lucky Air' },
  { code: 'AQ', name: '9 Air' },
  { code: 'UO', name: 'HK Express' },
  { code: 'IT', name: 'Tigerair Taiwan' },

  // Japan / South Korea.
  { code: 'MM', name: 'Peach Aviation' },
  { code: 'GK', name: 'Jetstar Japan' },
  { code: 'IJ', name: 'SPRING JAPAN' },
  { code: 'ZG', name: 'ZIPAIR Tokyo' },
  { code: '7C', name: 'Jeju Air' },
  { code: 'LJ', name: 'Jin Air' },
  { code: 'TW', name: 'T’way Air' },
  { code: 'ZE', name: 'Eastar Jet' },
  { code: 'RS', name: 'Air Seoul' },
  { code: 'BX', name: 'Air Busan' },
  { code: 'RF', name: 'Aero K' },

  // Central Asia / Australia.
  { code: 'FS', name: 'FlyArystan' },
  { code: 'JQ', name: 'Jetstar Airways' },

  // Europe / Turkey, including separately coded group carriers.
  { code: 'PC', name: 'Pegasus Airlines' },
  { code: 'VF', name: 'AJet' },
  { code: 'U2', name: 'easyJet' },
  { code: 'EC', name: 'easyJet Europe' },
  { code: 'DS', name: 'easyJet Switzerland' },
  { code: 'FR', name: 'Ryanair' },
  { code: 'RK', name: 'Ryanair UK' },
  { code: 'RR', name: 'Buzz' },
  { code: 'AL', name: 'Malta Air' },
  { code: 'W6', name: 'Wizz Air' },
  { code: 'W4', name: 'Wizz Air Malta' },
  { code: 'W9', name: 'Wizz Air UK' },
  { code: 'EW', name: 'Eurowings' },
  { code: 'VY', name: 'Vueling' },
  { code: 'HV', name: 'Transavia' },
  { code: 'TO', name: 'Transavia France' },
  { code: 'LS', name: 'Jet2.com' },
  { code: 'DY', name: 'Norwegian' },
  { code: 'D8', name: 'Norwegian Air Sweden' },
  { code: 'V7', name: 'Volotea' },
  { code: 'I2', name: 'Iberia Express' },
  { code: 'BF', name: 'French Bee' },
  { code: 'N0', name: 'Norse Atlantic Airways' },
  { code: 'Z0', name: 'Norse Atlantic UK' },
  { code: 'DP', name: 'Pobeda' },
  { code: '5F', name: 'FLYONE' },
  { code: '3F', name: 'FLYONE Armenia' },

  // North America / Mexico / Caribbean.
  { code: 'WN', name: 'Southwest Airlines' },
  { code: 'F9', name: 'Frontier Airlines' },
  { code: 'NK', name: 'Spirit Airlines' },
  { code: 'G4', name: 'Allegiant Air' },
  { code: 'SY', name: 'Sun Country Airlines' },
  { code: 'XP', name: 'Avelo Airlines' },
  { code: 'MX', name: 'Breeze Airways' },
  { code: 'F8', name: 'Flair Airlines' },
  { code: 'Y4', name: 'Volaris' },
  { code: 'Q6', name: 'Volaris Costa Rica' },
  { code: 'N3', name: 'Volaris El Salvador' },
  { code: 'VB', name: 'Viva' },
  { code: 'DM', name: 'Arajet' },

  // South America. JA is the shared JetSMART commercial flight code;
  // WJ/JZ still identify Argentina/Peru ticket plates in supplier data.
  { code: 'G3', name: 'GOL Linhas Aereas' },
  { code: 'H2', name: 'SKY Airline' },
  { code: 'H8', name: 'SKY Airline Peru' },
  { code: 'JA', name: 'JetSMART' },
  { code: 'WJ', name: 'JetSMART Argentina' },
  { code: 'JZ', name: 'JetSMART Peru' },
  { code: 'FO', name: 'Flybondi' },
  { code: 'P5', name: 'Wingo' },

  // Sub-Saharan Africa.
  { code: 'FA', name: 'FlySafair' },
  { code: 'JM', name: 'Jambojet' },
  { code: 'FN', name: 'Fastjet Zimbabwe' },
] as const;

const LCC_AIRLINE_CODES: ReadonlySet<string> = new Set(
  LCC_AIRLINES.map((airline) => airline.code),
);

export function isLccAirline(value: string | null | undefined): boolean {
  return typeof value === 'string' && LCC_AIRLINE_CODES.has(value.trim().toUpperCase());
}
