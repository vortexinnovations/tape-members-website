/**
 * Guest-list form translations (July 22, 2026).
 *
 * The QR self-add form is used at Tape Mykonos where many guests
 * don't speak English. Six languages, chosen for the island's actual
 * visitor mix: English (default), Greek (locals), Italian + French
 * (largest tourist groups), Spanish, German. Hebrew/Arabic are common
 * too but RTL needs layout mirroring — deliberately deferred.
 *
 * How it composes with the admin-configured copy on
 * /qrGuestlistAdmin: in ENGLISH the form keeps preferring the
 * session's admin-configured strings (formTitle, successMessage,
 * etc.). In any other language the static translations below are
 * used for EVERYTHING — an admin's custom English copy cannot be
 * machine-translated, so non-English guests get the stock copy.
 *
 * Backend error strings arrive in English; `translateBackendError`
 * maps the known ones to the active language and falls back to the
 * raw message for anything unrecognised.
 */

export type LangCode = "en" | "el" | "it" | "fr" | "es" | "de" | "pt";

export const LANGS: { code: LangCode; pill: string; name: string }[] = [
  { code: "en", pill: "EN", name: "English" },
  { code: "el", pill: "ΕΛ", name: "Ελληνικά" },
  { code: "it", pill: "IT", name: "Italiano" },
  { code: "fr", pill: "FR", name: "Français" },
  { code: "es", pill: "ES", name: "Español" },
  { code: "de", pill: "DE", name: "Deutsch" },
  { code: "pt", pill: "PT", name: "Português" },
];

export interface GuestlistStrings {
  formTitle: string;
  formSubtitle: string;
  fullNameLabel: string;
  fullNamePlaceholder: string;
  guestsLabel: string;
  guestPlaceholder: (n: number) => string;
  addGuest: string;
  removeGuest: string;
  upToGuests: (n: number) => string;
  emailLabel: string;
  optionalSuffix: string;
  emailPlaceholder: string;
  phoneLabel: string;
  phonePlaceholder: string;
  joining: string;
  joinButton: string;
  errName: string;
  errEmail: string;
  errPhone: string;
  errHuman: string;
  errGeneric: string;
  errNetwork: string;
  successTitle: string;
  successMessage: string;
  doorInstruction: string;
  onTheList: string;
  getDirections: string;
  makeAnother: string;
  appAdvert: string;
  // Known backend rejections (sent in English by submitGuestlistJoin).
  errFull: string;
  errExpired: string;
  errInvalidQr: string;
  errThrottle: string;
  errVerify: string;
  errSignupsClosed: string;
  errClosedList: string;
  // Fallback (dead-link) pages.
  fbNotFoundTitle: string;
  fbNotFoundMsg: string;
  fbSignupsClosedTitle: string;
  fbSignupsClosedMsg: string;
  fbListClosedTitle: string;
  fbListClosedMsg: string;
  fbFullTitle: string;
  fbFullMsg: string;
  fbAppNudge: string;
  // Short day/month names for localising the server-formatted
  // English date ("Wed 23 Jul 2026").
  days: string[];
  months: string[];
}

const EN_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EN_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export const STRINGS: Record<LangCode, GuestlistStrings> = {
  en: {
    formTitle: "Join the guest list",
    formSubtitle: "Add yourself and your guests to the list.",
    fullNameLabel: "Your full name",
    fullNamePlaceholder: "First and last name",
    guestsLabel: "Your guests (optional)",
    guestPlaceholder: (n) => `Guest ${n} full name`,
    addGuest: "+ Add a guest",
    removeGuest: "Remove guest",
    upToGuests: (n) => `Up to ${n} guests.`,
    emailLabel: "Email",
    optionalSuffix: " (optional)",
    emailPlaceholder: "you@example.com",
    phoneLabel: "Phone",
    phonePlaceholder: "Mobile number",
    joining: "Joining…",
    joinButton: "Join Guest List",
    errName: "Please enter your name.",
    errEmail: "Please enter your email address.",
    errPhone: "Please enter your phone number.",
    errHuman: "Just a moment — verifying you're human. Please try again.",
    errGeneric: "Something went wrong. Please try again.",
    errNetwork: "Network error. Please try again.",
    successTitle: "You're on the list!",
    successMessage: "Screenshot the QR code below and show it at the door.",
    doorInstruction: "Show this QR code at the door.",
    onTheList: "On the list",
    getDirections: "Get directions",
    makeAnother: "+ Make another booking",
    appAdvert:
      "We've also got an app — earn Tape Coins on every visit and " +
      "unlock rewards & discounts.",
    errFull: "Sorry, this guest list is now full.",
    errExpired: "This guest list has expired.",
    errInvalidQr: "This QR code is no longer valid.",
    errThrottle: "Too many sign-ups from this device. Try again later.",
    errVerify: "Verification failed. Please try again.",
    errSignupsClosed: "Guest list sign-ups are currently closed.",
    errClosedList: "This guest list is closed.",
    fbNotFoundTitle: "Link not found",
    fbNotFoundMsg:
      "This guest-list link is no longer valid. Ask the promoter for a " +
      "fresh one.",
    fbSignupsClosedTitle: "Sign-ups closed",
    fbSignupsClosedMsg:
      "Guest-list sign-ups are currently closed. Please check back later.",
    fbListClosedTitle: "Guest list closed",
    fbListClosedMsg:
      "This guest list has closed. Ask the promoter for tonight's link.",
    fbFullTitle: "Guest list full",
    fbFullMsg: "Sorry — this guest list is now full.",
    fbAppNudge: "While you're here — get the Tape Members app:",
    days: EN_DAYS,
    months: EN_MONTHS,
  },

  el: {
    formTitle: "Μπες στη λίστα καλεσμένων",
    formSubtitle: "Πρόσθεσε εσένα και την παρέα σου στη λίστα.",
    fullNameLabel: "Το ονοματεπώνυμό σου",
    fullNamePlaceholder: "Όνομα και επώνυμο",
    guestsLabel: "Οι καλεσμένοι σου (προαιρετικό)",
    guestPlaceholder: (n) => `Ονοματεπώνυμο καλεσμένου ${n}`,
    addGuest: "+ Πρόσθεσε καλεσμένο",
    removeGuest: "Αφαίρεση καλεσμένου",
    upToGuests: (n) => `Έως ${n} καλεσμένοι.`,
    emailLabel: "Email",
    optionalSuffix: " (προαιρετικό)",
    emailPlaceholder: "you@example.com",
    phoneLabel: "Τηλέφωνο",
    phonePlaceholder: "Αριθμός κινητού",
    joining: "Καταχώρηση…",
    joinButton: "Μπες στη λίστα",
    errName: "Γράψε το όνομά σου.",
    errEmail: "Γράψε τη διεύθυνση email σου.",
    errPhone: "Γράψε τον αριθμό τηλεφώνου σου.",
    errHuman:
      "Μια στιγμή — επιβεβαιώνουμε ότι είσαι άνθρωπος. Δοκίμασε ξανά.",
    errGeneric: "Κάτι πήγε στραβά. Δοκίμασε ξανά.",
    errNetwork: "Σφάλμα δικτύου. Δοκίμασε ξανά.",
    successTitle: "Είσαι στη λίστα!",
    successMessage:
      "Βγάλε screenshot το QR παρακάτω και δείξ' το στην πόρτα.",
    doorInstruction: "Δείξε αυτό το QR στην πόρτα.",
    onTheList: "Στη λίστα",
    getDirections: "Οδηγίες πρόσβασης",
    makeAnother: "+ Νέα κράτηση",
    appAdvert:
      "Έχουμε και εφαρμογή — κέρδισε Tape Coins σε κάθε επίσκεψη και " +
      "ξεκλείδωσε προνόμια & εκπτώσεις.",
    errFull: "Δυστυχώς, η λίστα είναι πλέον γεμάτη.",
    errExpired: "Αυτή η λίστα έχει λήξει.",
    errInvalidQr: "Αυτό το QR δεν ισχύει πια.",
    errThrottle:
      "Πολλές εγγραφές από αυτή τη συσκευή. Δοκίμασε ξανά αργότερα.",
    errVerify: "Η επαλήθευση απέτυχε. Δοκίμασε ξανά.",
    errSignupsClosed: "Οι εγγραφές στη λίστα είναι προσωρινά κλειστές.",
    errClosedList: "Αυτή η λίστα είναι κλειστή.",
    fbNotFoundTitle: "Ο σύνδεσμος δεν βρέθηκε",
    fbNotFoundMsg:
      "Αυτός ο σύνδεσμος δεν ισχύει πια. Ζήτησε καινούριο από τον " +
      "promoter.",
    fbSignupsClosedTitle: "Εγγραφές κλειστές",
    fbSignupsClosedMsg:
      "Οι εγγραφές είναι προσωρινά κλειστές. Δοκίμασε ξανά αργότερα.",
    fbListClosedTitle: "Η λίστα έκλεισε",
    fbListClosedMsg:
      "Αυτή η λίστα έχει κλείσει. Ζήτησε από τον promoter τον σημερινό " +
      "σύνδεσμο.",
    fbFullTitle: "Η λίστα είναι γεμάτη",
    fbFullMsg: "Δυστυχώς, η λίστα είναι πλέον γεμάτη.",
    fbAppNudge: "Όσο είσαι εδώ — κατέβασε την εφαρμογή Tape Members:",
    days: ["Κυρ", "Δευ", "Τρί", "Τετ", "Πέμ", "Παρ", "Σάβ"],
    months: [
      "Ιαν", "Φεβ", "Μαρ", "Απρ", "Μαΐ", "Ιουν",
      "Ιουλ", "Αυγ", "Σεπ", "Οκτ", "Νοε", "Δεκ",
    ],
  },

  it: {
    formTitle: "Entra in lista",
    formSubtitle: "Aggiungi te e i tuoi ospiti alla lista.",
    fullNameLabel: "Il tuo nome completo",
    fullNamePlaceholder: "Nome e cognome",
    guestsLabel: "I tuoi ospiti (facoltativo)",
    guestPlaceholder: (n) => `Nome completo dell'ospite ${n}`,
    addGuest: "+ Aggiungi un ospite",
    removeGuest: "Rimuovi ospite",
    upToGuests: (n) => `Fino a ${n} ospiti.`,
    emailLabel: "Email",
    optionalSuffix: " (facoltativo)",
    emailPlaceholder: "tu@esempio.com",
    phoneLabel: "Telefono",
    phonePlaceholder: "Numero di cellulare",
    joining: "Invio…",
    joinButton: "Entra in lista",
    errName: "Inserisci il tuo nome.",
    errEmail: "Inserisci il tuo indirizzo email.",
    errPhone: "Inserisci il tuo numero di telefono.",
    errHuman:
      "Un attimo — stiamo verificando che tu non sia un robot. Riprova.",
    errGeneric: "Qualcosa è andato storto. Riprova.",
    errNetwork: "Errore di rete. Riprova.",
    successTitle: "Sei in lista!",
    successMessage:
      "Fai uno screenshot del codice QR qui sotto e mostralo " +
      "all'ingresso.",
    doorInstruction: "Mostra questo codice QR all'ingresso.",
    onTheList: "In lista",
    getDirections: "Indicazioni",
    makeAnother: "+ Nuova prenotazione",
    appAdvert:
      "Abbiamo anche un'app — guadagna Tape Coins a ogni visita e " +
      "sblocca premi e sconti.",
    errFull: "Spiacenti, la lista è al completo.",
    errExpired: "Questa lista è scaduta.",
    errInvalidQr: "Questo codice QR non è più valido.",
    errThrottle:
      "Troppe registrazioni da questo dispositivo. Riprova più tardi.",
    errVerify: "Verifica non riuscita. Riprova.",
    errSignupsClosed:
      "Le iscrizioni alla lista sono momentaneamente chiuse.",
    errClosedList: "Questa lista è chiusa.",
    fbNotFoundTitle: "Link non trovato",
    fbNotFoundMsg:
      "Questo link non è più valido. Chiedi al promoter un nuovo link.",
    fbSignupsClosedTitle: "Iscrizioni chiuse",
    fbSignupsClosedMsg:
      "Le iscrizioni sono momentaneamente chiuse. Riprova più tardi.",
    fbListClosedTitle: "Lista chiusa",
    fbListClosedMsg:
      "Questa lista è chiusa. Chiedi al promoter il link di stasera.",
    fbFullTitle: "Lista al completo",
    fbFullMsg: "Spiacenti — la lista è al completo.",
    fbAppNudge: "Già che sei qui — scarica l'app Tape Members:",
    days: ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"],
    months: [
      "Gen", "Feb", "Mar", "Apr", "Mag", "Giu",
      "Lug", "Ago", "Set", "Ott", "Nov", "Dic",
    ],
  },

  fr: {
    formTitle: "Rejoins la guest list",
    formSubtitle: "Ajoute-toi ainsi que tes invités à la liste.",
    fullNameLabel: "Ton nom complet",
    fullNamePlaceholder: "Prénom et nom",
    guestsLabel: "Tes invités (facultatif)",
    guestPlaceholder: (n) => `Nom complet de l'invité ${n}`,
    addGuest: "+ Ajouter un invité",
    removeGuest: "Retirer l'invité",
    upToGuests: (n) => `Jusqu'à ${n} invités.`,
    emailLabel: "E-mail",
    optionalSuffix: " (facultatif)",
    emailPlaceholder: "toi@exemple.com",
    phoneLabel: "Téléphone",
    phonePlaceholder: "Numéro de portable",
    joining: "Envoi…",
    joinButton: "Rejoindre la liste",
    errName: "Entre ton nom.",
    errEmail: "Entre ton adresse e-mail.",
    errPhone: "Entre ton numéro de téléphone.",
    errHuman:
      "Un instant — on vérifie que tu n'es pas un robot. Réessaie.",
    errGeneric: "Une erreur est survenue. Réessaie.",
    errNetwork: "Erreur réseau. Réessaie.",
    successTitle: "Tu es sur la liste !",
    successMessage:
      "Fais une capture d'écran du QR code ci-dessous et montre-le à " +
      "l'entrée.",
    doorInstruction: "Montre ce QR code à l'entrée.",
    onTheList: "Sur la liste",
    getDirections: "Itinéraire",
    makeAnother: "+ Nouvelle réservation",
    appAdvert:
      "On a aussi une appli — gagne des Tape Coins à chaque visite et " +
      "débloque récompenses et réductions.",
    errFull: "Désolé, la liste est complète.",
    errExpired: "Cette liste a expiré.",
    errInvalidQr: "Ce QR code n'est plus valide.",
    errThrottle:
      "Trop d'inscriptions depuis cet appareil. Réessaie plus tard.",
    errVerify: "Échec de la vérification. Réessaie.",
    errSignupsClosed: "Les inscriptions sont momentanément fermées.",
    errClosedList: "Cette liste est fermée.",
    fbNotFoundTitle: "Lien introuvable",
    fbNotFoundMsg:
      "Ce lien n'est plus valide. Demande un nouveau lien au promoteur.",
    fbSignupsClosedTitle: "Inscriptions fermées",
    fbSignupsClosedMsg:
      "Les inscriptions sont momentanément fermées. Réessaie plus tard.",
    fbListClosedTitle: "Liste fermée",
    fbListClosedMsg:
      "Cette liste est fermée. Demande au promoteur le lien de ce soir.",
    fbFullTitle: "Liste complète",
    fbFullMsg: "Désolé — la liste est complète.",
    fbAppNudge: "Pendant que tu es là — télécharge l'appli Tape Members :",
    days: ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"],
    months: [
      "Janv", "Févr", "Mars", "Avr", "Mai", "Juin",
      "Juil", "Août", "Sept", "Oct", "Nov", "Déc",
    ],
  },

  es: {
    formTitle: "Apúntate a la lista",
    formSubtitle: "Añádete a ti y a tus invitados a la lista.",
    fullNameLabel: "Tu nombre completo",
    fullNamePlaceholder: "Nombre y apellidos",
    guestsLabel: "Tus invitados (opcional)",
    guestPlaceholder: (n) => `Nombre completo del invitado ${n}`,
    addGuest: "+ Añadir invitado",
    removeGuest: "Quitar invitado",
    upToGuests: (n) => `Hasta ${n} invitados.`,
    emailLabel: "Email",
    optionalSuffix: " (opcional)",
    emailPlaceholder: "tu@ejemplo.com",
    phoneLabel: "Teléfono",
    phonePlaceholder: "Número de móvil",
    joining: "Enviando…",
    joinButton: "Unirme a la lista",
    errName: "Escribe tu nombre.",
    errEmail: "Escribe tu dirección de email.",
    errPhone: "Escribe tu número de teléfono.",
    errHuman:
      "Un momento — verificando que eres humano. Inténtalo de nuevo.",
    errGeneric: "Algo salió mal. Inténtalo de nuevo.",
    errNetwork: "Error de red. Inténtalo de nuevo.",
    successTitle: "¡Estás en la lista!",
    successMessage:
      "Haz una captura del código QR de abajo y muéstralo en la puerta.",
    doorInstruction: "Muestra este código QR en la puerta.",
    onTheList: "En la lista",
    getDirections: "Cómo llegar",
    makeAnother: "+ Hacer otra reserva",
    appAdvert:
      "También tenemos app — gana Tape Coins en cada visita y " +
      "desbloquea recompensas y descuentos.",
    errFull: "Lo sentimos, la lista está completa.",
    errExpired: "Esta lista ha caducado.",
    errInvalidQr: "Este código QR ya no es válido.",
    errThrottle:
      "Demasiados registros desde este dispositivo. Inténtalo más tarde.",
    errVerify: "La verificación falló. Inténtalo de nuevo.",
    errSignupsClosed:
      "Las inscripciones están cerradas temporalmente.",
    errClosedList: "Esta lista está cerrada.",
    fbNotFoundTitle: "Enlace no encontrado",
    fbNotFoundMsg:
      "Este enlace ya no es válido. Pide uno nuevo al promotor.",
    fbSignupsClosedTitle: "Inscripciones cerradas",
    fbSignupsClosedMsg:
      "Las inscripciones están cerradas temporalmente. Vuelve más tarde.",
    fbListClosedTitle: "Lista cerrada",
    fbListClosedMsg:
      "Esta lista ha cerrado. Pide al promotor el enlace de esta noche.",
    fbFullTitle: "Lista completa",
    fbFullMsg: "Lo sentimos — la lista está completa.",
    fbAppNudge: "Ya que estás aquí — descarga la app de Tape Members:",
    days: ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"],
    months: [
      "Ene", "Feb", "Mar", "Abr", "May", "Jun",
      "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
    ],
  },

  de: {
    formTitle: "Auf die Gästeliste",
    formSubtitle: "Trag dich und deine Gäste in die Liste ein.",
    fullNameLabel: "Dein vollständiger Name",
    fullNamePlaceholder: "Vor- und Nachname",
    guestsLabel: "Deine Gäste (optional)",
    guestPlaceholder: (n) => `Vollständiger Name von Gast ${n}`,
    addGuest: "+ Gast hinzufügen",
    removeGuest: "Gast entfernen",
    upToGuests: (n) => `Bis zu ${n} Gäste.`,
    emailLabel: "E-Mail",
    optionalSuffix: " (optional)",
    emailPlaceholder: "du@beispiel.com",
    phoneLabel: "Telefon",
    phonePlaceholder: "Handynummer",
    joining: "Wird gesendet…",
    joinButton: "Auf die Liste",
    errName: "Bitte gib deinen Namen ein.",
    errEmail: "Bitte gib deine E-Mail-Adresse ein.",
    errPhone: "Bitte gib deine Telefonnummer ein.",
    errHuman:
      "Einen Moment — wir prüfen, dass du ein Mensch bist. Versuch es " +
      "nochmal.",
    errGeneric: "Etwas ist schiefgelaufen. Versuch es nochmal.",
    errNetwork: "Netzwerkfehler. Versuch es nochmal.",
    successTitle: "Du stehst auf der Liste!",
    successMessage:
      "Mach einen Screenshot vom QR-Code unten und zeig ihn an der Tür.",
    doorInstruction: "Zeig diesen QR-Code an der Tür.",
    onTheList: "Auf der Liste",
    getDirections: "Route anzeigen",
    makeAnother: "+ Weitere Buchung",
    appAdvert:
      "Wir haben auch eine App — sammle Tape Coins bei jedem Besuch " +
      "und sichere dir Prämien & Rabatte.",
    errFull: "Sorry, die Liste ist voll.",
    errExpired: "Diese Liste ist abgelaufen.",
    errInvalidQr: "Dieser QR-Code ist nicht mehr gültig.",
    errThrottle:
      "Zu viele Anmeldungen von diesem Gerät. Versuch es später nochmal.",
    errVerify: "Verifizierung fehlgeschlagen. Versuch es nochmal.",
    errSignupsClosed: "Anmeldungen sind derzeit geschlossen.",
    errClosedList: "Diese Liste ist geschlossen.",
    fbNotFoundTitle: "Link nicht gefunden",
    fbNotFoundMsg:
      "Dieser Link ist nicht mehr gültig. Frag den Promoter nach einem " +
      "neuen.",
    fbSignupsClosedTitle: "Anmeldungen geschlossen",
    fbSignupsClosedMsg:
      "Anmeldungen sind derzeit geschlossen. Schau später nochmal vorbei.",
    fbListClosedTitle: "Gästeliste geschlossen",
    fbListClosedMsg:
      "Diese Liste ist geschlossen. Frag den Promoter nach dem Link " +
      "für heute Abend.",
    fbFullTitle: "Gästeliste voll",
    fbFullMsg: "Sorry — die Liste ist voll.",
    fbAppNudge: "Wo du schon hier bist — hol dir die Tape Members App:",
    days: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
    months: [
      "Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
      "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
    ],
  },

  pt: {
    formTitle: "Entra na guest list",
    formSubtitle: "Adiciona-te a ti e aos teus convidados à lista.",
    fullNameLabel: "O teu nome completo",
    fullNamePlaceholder: "Nome e apelido",
    guestsLabel: "Os teus convidados (opcional)",
    guestPlaceholder: (n) => `Nome completo do convidado ${n}`,
    addGuest: "+ Adicionar convidado",
    removeGuest: "Remover convidado",
    upToGuests: (n) => `Até ${n} convidados.`,
    emailLabel: "Email",
    optionalSuffix: " (opcional)",
    emailPlaceholder: "tu@exemplo.com",
    phoneLabel: "Telefone",
    phonePlaceholder: "Número de telemóvel",
    joining: "A enviar…",
    joinButton: "Entrar na lista",
    errName: "Escreve o teu nome.",
    errEmail: "Escreve o teu endereço de email.",
    errPhone: "Escreve o teu número de telefone.",
    errHuman:
      "Um momento — a verificar que és humano. Tenta novamente.",
    errGeneric: "Algo correu mal. Tenta novamente.",
    errNetwork: "Erro de rede. Tenta novamente.",
    successTitle: "Estás na lista!",
    successMessage:
      "Faz uma captura de ecrã do código QR abaixo e mostra-o à porta.",
    doorInstruction: "Mostra este código QR à porta.",
    onTheList: "Na lista",
    getDirections: "Direções",
    makeAnother: "+ Fazer outra reserva",
    appAdvert:
      "Também temos uma app — ganha Tape Coins em cada visita e " +
      "desbloqueia recompensas e descontos.",
    errFull: "Lamentamos, a lista está cheia.",
    errExpired: "Esta lista expirou.",
    errInvalidQr: "Este código QR já não é válido.",
    errThrottle:
      "Demasiados registos deste dispositivo. Tenta mais tarde.",
    errVerify: "A verificação falhou. Tenta novamente.",
    errSignupsClosed:
      "As inscrições estão temporariamente fechadas.",
    errClosedList: "Esta lista está fechada.",
    fbNotFoundTitle: "Link não encontrado",
    fbNotFoundMsg:
      "Este link já não é válido. Pede um novo ao promotor.",
    fbSignupsClosedTitle: "Inscrições fechadas",
    fbSignupsClosedMsg:
      "As inscrições estão temporariamente fechadas. Volta mais tarde.",
    fbListClosedTitle: "Lista fechada",
    fbListClosedMsg:
      "Esta lista fechou. Pede ao promotor o link de hoje à noite.",
    fbFullTitle: "Lista cheia",
    fbFullMsg: "Lamentamos — a lista está cheia.",
    fbAppNudge: "Já que estás aqui — descarrega a app Tape Members:",
    days: ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"],
    months: [
      "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
      "Jul", "Ago", "Set", "Out", "Nov", "Dez",
    ],
  },
};

/** Best-match a LangCode from an Accept-Language header (or a
 *  navigator.language string). Falls back to English. */
export function pickLang(accept: string | null | undefined): LangCode {
  if (!accept) return "en";
  const codes = accept
    .toLowerCase()
    .split(",")
    .map((part) => part.split(";")[0].trim().slice(0, 2));
  for (const c of codes) {
    if (c === "en" || c === "el" || c === "it" || c === "fr" ||
        c === "es" || c === "de" || c === "pt") {
      return c as LangCode;
    }
  }
  return "en";
}

/** Map a known English backend error to the active language.
 *  Unrecognised messages pass through untranslated. */
export function translateBackendError(
  msg: string,
  s: GuestlistStrings,
): string {
  const en = STRINGS.en;
  const map: [string, string][] = [
    [en.errName, s.errName],
    ["Please enter a valid email address.", s.errEmail],
    ["That email address doesn’t look right.", s.errEmail],
    [en.errPhone, s.errPhone],
    [en.errFull, s.errFull],
    [en.errExpired, s.errExpired],
    [en.errInvalidQr, s.errInvalidQr],
    [en.errThrottle, s.errThrottle],
    [en.errVerify, s.errVerify],
    [en.errSignupsClosed, s.errSignupsClosed],
    [en.errClosedList, s.errClosedList],
    ["Something went wrong. Please try again.", s.errGeneric],
  ];
  for (const [english, translated] of map) {
    if (msg === english) return translated;
  }
  return msg;
}

/** Localise the backend's English date display ("Wed 23 Jul 2026")
 *  into the active language. Returns the input untouched if it
 *  doesn't match the expected shape. */
export function localizeDateDisplay(
  display: string,
  s: GuestlistStrings,
): string {
  const m = /^([A-Za-z]{3}) (\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(
    display || "",
  );
  if (!m) return display;
  const dayIdx = EN_DAYS.indexOf(m[1]);
  const monthIdx = EN_MONTHS.indexOf(m[3]);
  if (dayIdx < 0 || monthIdx < 0) return display;
  return `${s.days[dayIdx]} ${m[2]} ${s.months[monthIdx]} ${m[4]}`;
}
