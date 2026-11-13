// Static pools for the mock provider. Team names are real clubs so the UI looks
// familiar, but EVERY number attached to them in mock mode is simulated and
// labelled "MINTA". Players (tennis, goalies, injuries) are fictional on purpose,
// so no invented claim is ever made about a real person.

export const TEAMS = {
  nba: ['Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets', 'Chicago Bulls', 'Cleveland Cavaliers', 'Dallas Mavericks', 'Denver Nuggets', 'Detroit Pistons', 'Golden State Warriors', 'Houston Rockets', 'Indiana Pacers', 'LA Clippers', 'Los Angeles Lakers', 'Memphis Grizzlies', 'Miami Heat', 'Milwaukee Bucks', 'Minnesota Timberwolves', 'New Orleans Pelicans', 'New York Knicks', 'Oklahoma City Thunder', 'Orlando Magic', 'Philadelphia 76ers', 'Phoenix Suns', 'Portland Trail Blazers', 'Sacramento Kings', 'San Antonio Spurs', 'Toronto Raptors', 'Utah Jazz', 'Washington Wizards'],
  nhl: ['Anaheim Ducks', 'Boston Bruins', 'Buffalo Sabres', 'Calgary Flames', 'Carolina Hurricanes', 'Chicago Blackhawks', 'Colorado Avalanche', 'Columbus Blue Jackets', 'Dallas Stars', 'Detroit Red Wings', 'Edmonton Oilers', 'Florida Panthers', 'Los Angeles Kings', 'Minnesota Wild', 'Montréal Canadiens', 'Nashville Predators', 'New Jersey Devils', 'New York Islanders', 'New York Rangers', 'Ottawa Senators', 'Philadelphia Flyers', 'Pittsburgh Penguins', 'San Jose Sharks', 'Seattle Kraken', 'St. Louis Blues', 'Tampa Bay Lightning', 'Toronto Maple Leafs', 'Utah Mammoth', 'Vancouver Canucks', 'Vegas Golden Knights', 'Washington Capitals', 'Winnipeg Jets'],
  epl: ['Arsenal', 'Aston Villa', 'Bournemouth', 'Brentford', 'Brighton', 'Burnley', 'Chelsea', 'Crystal Palace', 'Everton', 'Fulham', 'Leeds United', 'Liverpool', 'Manchester City', 'Manchester United', 'Newcastle United', 'Nottingham Forest', 'Sunderland', 'Tottenham Hotspur', 'West Ham United', 'Wolverhampton'],
  laliga: ['Real Madrid', 'Barcelona', 'Atlético Madrid', 'Athletic Club', 'Real Sociedad', 'Real Betis', 'Villarreal', 'Valencia', 'Sevilla', 'Girona', 'Osasuna', 'Celta Vigo', 'Getafe', 'Rayo Vallecano', 'Mallorca', 'Alavés', 'Espanyol', 'Levante', 'Elche', 'Real Oviedo'],
  seriea: ['Inter', 'Milan', 'Juventus', 'Napoli', 'Roma', 'Lazio', 'Atalanta', 'Fiorentina', 'Bologna', 'Torino', 'Udinese', 'Genoa', 'Como', 'Cagliari', 'Lecce', 'Parma', 'Verona', 'Sassuolo', 'Cremonese', 'Pisa'],
  bundesliga: ['Bayern München', 'Borussia Dortmund', 'Bayer Leverkusen', 'RB Leipzig', 'Eintracht Frankfurt', 'VfB Stuttgart', 'SC Freiburg', 'VfL Wolfsburg', "Borussia M'gladbach", 'Werder Bremen', 'Union Berlin', 'TSG Hoffenheim', 'FC Augsburg', 'Mainz 05', 'Heidenheim', 'St. Pauli', '1. FC Köln', 'Hamburger SV'],
  ligue1: ['Paris Saint-Germain', 'Marseille', 'Monaco', 'Lille', 'Nice', 'Lyon', 'Lens', 'Rennes', 'Strasbourg', 'Brest', 'Nantes', 'Toulouse', 'Auxerre', 'Angers', 'Le Havre', 'Lorient', 'Paris FC', 'Metz'],
  ucl: ['Real Madrid', 'Barcelona', 'Bayern München', 'Manchester City', 'Liverpool', 'Arsenal', 'Inter', 'Paris Saint-Germain', 'Borussia Dortmund', 'Atlético Madrid', 'Juventus', 'Napoli', 'Benfica', 'Sporting CP', 'PSV Eindhoven', 'Ajax', 'Club Brugge', 'Galatasaray', 'Olympiakos', 'Slavia Praha', 'Bodø/Glimt', 'Union SG', 'Copenhagen', 'Qarabağ', 'Eintracht Frankfurt', 'Bayer Leverkusen', 'Chelsea', 'Tottenham Hotspur', 'Newcastle United', 'Marseille', 'Monaco', 'Atalanta', 'Villarreal', 'Athletic Club'],
  uel: ['Manchester United', 'Tottenham Hotspur', 'Roma', 'Lazio', 'Porto', 'Lyon', 'Real Sociedad', 'Rangers', 'Fenerbahçe', 'Ajax', 'AZ Alkmaar', 'Braga', 'Olympique Marseille', 'Eintracht Frankfurt', 'Viktoria Plzeň', 'Ferencváros', 'Midtjylland', 'Anderlecht', 'Besiktas', 'Celtic', 'Real Betis', 'Nottingham Forest', 'Aston Villa', 'Feyenoord'],
  uecl: ['Fiorentina', 'Chelsea', 'Crystal Palace', 'Rayo Vallecano', 'Strasbourg', 'Mainz 05', 'AEK Athens', 'Legia Warszawa', 'Shakhtar Donetsk', 'Rapid Wien', 'Lech Poznań', 'Sparta Praha', 'Shamrock Rovers', 'Omonia', 'Celje', 'Lausanne', 'Samsunspor', 'Jagiellonia', 'Häcken', 'Dinamo Zagreb', 'Paksi FC', 'Puskás Akadémia'],
  eredivisie: ['PSV Eindhoven', 'Feyenoord', 'Ajax', 'AZ Alkmaar', 'FC Twente', 'FC Utrecht', 'NEC Nijmegen', 'Go Ahead Eagles', 'Heerenveen', 'Sparta Rotterdam', 'Groningen', 'Fortuna Sittard', 'PEC Zwolle', 'Heracles', 'NAC Breda', 'Excelsior', 'Telstar', 'Volendam'],
  primeira: ['Benfica', 'Porto', 'Sporting CP', 'Braga', 'Vitória Guimarães', 'Famalicão', 'Gil Vicente', 'Moreirense', 'Estoril', 'Casa Pia', 'Santa Clara', 'Rio Ave', 'Arouca', 'Nacional', 'Estrela Amadora', 'Alverca', 'Tondela', 'AVS'],
  championship: ['Leicester City', 'Ipswich Town', 'Southampton', 'Sheffield United', 'Middlesbrough', 'Coventry City', 'West Bromwich', 'Norwich City', 'Watford', 'Bristol City', 'Millwall', 'Hull City', 'Stoke City', 'Swansea City', 'Preston North End', 'QPR', 'Derby County', 'Blackburn Rovers', 'Portsmouth', 'Wrexham', 'Charlton Athletic', 'Birmingham City', 'Oxford United', 'Sheffield Wednesday'],
  superlig: ['Galatasaray', 'Fenerbahçe', 'Besiktas', 'Trabzonspor', 'Başakşehir', 'Samsunspor', 'Göztepe', 'Eyüpspor', 'Kasımpaşa', 'Antalyaspor', 'Konyaspor', 'Alanyaspor', 'Rizespor', 'Gaziantep', 'Kayserispor', 'Kocaelispor', 'Gençlerbirliği', 'Karagümrük'],
  belgium: ['Club Brugge', 'Union SG', 'Anderlecht', 'Genk', 'Gent', 'Antwerp', 'Standard Liège', 'Mechelen', 'Westerlo', 'Charleroi', 'Sint-Truiden', 'Cercle Brugge', 'OH Leuven', 'Zulte Waregem', 'La Louvière', 'Dender'],
  scotland: ['Celtic', 'Rangers', 'Hearts', 'Hibernian', 'Aberdeen', 'Motherwell', 'Dundee United', 'St Mirren', 'Kilmarnock', 'Dundee', 'Falkirk', 'Livingston'],
  mls: ['Inter Miami', 'LA Galaxy', 'LAFC', 'Seattle Sounders', 'Columbus Crew', 'FC Cincinnati', 'Philadelphia Union', 'New York City FC', 'New York Red Bulls', 'Orlando City', 'Atlanta United', 'Nashville SC', 'Vancouver Whitecaps', 'Minnesota United', 'San Diego FC', 'Charlotte FC', 'Portland Timbers', 'Real Salt Lake'],
  // Handball (real clubs, simulated numbers)
  ehfcl: ['Veszprém', 'OTP Bank-Pick Szeged', 'Barça', 'THW Kiel', 'SC Magdeburg', 'Füchse Berlin', 'Paris Saint-Germain Handball', 'Aalborg Håndbold', 'Industria Kielce', 'Sporting CP', 'GOG', 'Wisła Płock', 'Dinamo București', 'Kolstad', 'Nantes', 'Eurofarm Pelister'],
  ehfclw: ['Győri Audi ETO KC', 'FTC-Rail Cargo Hungaria', 'Team Esbjerg', 'Metz Handball', 'CSM București', 'Odense Håndbold', 'Brest Bretagne', 'Ikast Håndbold', 'Krim Mercator', 'Storhamar', 'Borussia Dortmund Handball', 'Budućnost', 'Sola HK', 'Gloria Bistrița', 'DVSC Schaeffler', 'Podravka'],
  hbnbi: ['Veszprém', 'OTP Bank-Pick Szeged', 'FTC', 'Tatabánya', 'Balatonfüredi KSE', 'Csurgói KK', 'Dabas', 'Ceglédi KKSE', 'Komlói BSK', 'NEKA', 'Budakalász', 'HE-DO B. Braun Gyöngyös'],
  hbnbiw: ['Győri Audi ETO KC', 'FTC-Rail Cargo Hungaria', 'DVSC Schaeffler', 'Motherson Mosonmagyaróvár', 'Vác', 'MTK Budapest', 'Kisvárda', 'Esztergom', 'Békéscsaba', 'Dunaújváros', 'Alba Fehérvár', 'Budaörs'],
  hbl: ['SC Magdeburg', 'Füchse Berlin', 'THW Kiel', 'SG Flensburg-Handewitt', 'MT Melsungen', 'Rhein-Neckar Löwen', 'TSV Hannover-Burgdorf', 'HSV Hamburg', 'Frisch Auf Göppingen', 'VfL Gummersbach', 'SC DHfK Leipzig', 'HC Erlangen', 'TBV Lemgo Lippe', 'Bergischer HC', 'ThSV Eisenach', 'TVB Stuttgart'],
  nbi: ['Ferencváros', 'Puskás Akadémia', 'Paksi FC', 'ETO FC', 'Debreceni VSC', 'MTK Budapest', 'Újpest FC', 'Zalaegerszegi TE', 'Diósgyőri VTK', 'Nyíregyháza Spartacus', 'Kisvárda FC', 'Kazincbarcika'],
};

// Fictional tennis players (mock mode only).
export const PLAYERS = {
  atp: ['Márk Varga', 'Luca Ferretti', 'Tomás Rivera', 'Jonas Lindqvist', 'Arthur Lemaire', 'Kenji Morita', 'Daniel Hughes', 'Nikolai Petrov', 'Felipe Duarte', 'Oskar Brandt', 'Mateo Santoro', 'Ilya Sorokin', 'Ben Carter', 'Hugo Martel', 'Stefan Novak', 'Adrian Kowal', 'Lars Engel', 'Rafael Mota', 'Samuel Price', 'Viktor Hale'],
  wta: ['Anna Szabó', 'Elena Moretti', 'Sofia Reyes', 'Mia Johansson', 'Chloé Bernard', 'Yuki Tanaka', 'Grace Miller', 'Daria Volkova', 'Laura Costa', 'Emma Fischer', 'Nina Horvat', 'Julia Nowak', 'Olivia Brooks', 'Camille Dubois', 'Lea Kraus', 'Valeria Ruiz', 'Ida Lund', 'Marta Silva', 'Zoe Hart', 'Irina Lebed'],
};

export const SURNAMES = ['Novak', 'Hale', 'Moreau', 'Lindgren', 'Okafor', 'Brennan', 'Kowalski', 'Duarte', 'Ivanov', 'Schmidt', 'Rossi', 'Kane', 'Mendes', 'Larsen', 'Takahashi', 'Fischer', 'Silva', 'Petrov', 'Laine', 'Costa', 'Tóth', 'Farkas', 'Berger', 'Walsh'];
export const INITIALS = 'ABCDEFGHJKLMNOPRSTVZ';
export const INJURY_TYPES = ['térd', 'boka', 'combhajlító', 'váll', 'hát', 'agyrázkódás-protokoll', 'betegség'];
export const BOOKS = ['Minta Fogadó A', 'Minta Fogadó B', 'Minta Fogadó C'];

// High-altitude venues (metres) for the altitude factor.
export const ALTITUDE = { 'Denver Nuggets': 1609, 'Colorado Avalanche': 1609, 'Utah Jazz': 1288, 'Utah Mammoth': 1288 };
