/**
 * Deterministic safety layer. Everything here runs WITHOUT a language model, so a model failure, a prompt injection
 * or a hallucination cannot weaken it (spec 13.3, RN-013, RN-022, RN-023).
 */

/** Lowercase, no accents, single spaces. */
export const normalize = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// Possible emergency. Deliberately broad: a false alarm costs a human glance, a miss costs far more (RN-023).
const URGENCY = [
  /\bdolor (muy |re |super )?(fuerte|intenso|insoportable|terrible|horrible)\b/,
  /\bme duele (mucho|muchisimo|demasiado|horrible|una barbaridad)\b/,
  /\bno (aguanto|soporto) (mas )?(el )?dolor\b/,
  /\bsangr(a|an|ado|ando|ia|o|e)\b/, /\bhemorragia\b/,
  /\b(cara|cuello|garganta|ojo|mejilla|encia) (muy )?(hinchad[ao]|inflamad[ao])\b/, /\bhinchazon\b/, /\bse me hincho\b/,
  /\bno puedo (respirar|tragar|abrir la boca|hablar)\b/, /\bme (ahogo|falta el aire)\b/, /\bfalta de aire\b/, /\bdificultad (para|al) (respirar|tragar)\b/,
  /\b(me )?(golpe[eo]|golpearon|accidente|trauma|traumatismo)\b/, /\bse me (rompio|partio|cayo|salio) (el |un |una )?(diente|muela|pieza)\b/,
  /\bfiebre\b/, /\b(desmay|convuls)\w*/,
  /\burgenc\w*\b/, /\bemergencia\b/, /\burgente\b/,
];
export const isUrgent = (text: string): boolean => { const t = normalize(text); return URGENCY.some((r) => r.test(t)); };

const HUMAN = [
  /\b(humano|humana)\b/, /\bpersona real\b/, /\brecepcion(ista)?\b/, /\boperador(a)?\b/, /\bagente humano\b/,
  /\bhablar con (alguien|una persona|un humano|recepcion|la clinica|el doctor|la doctora)\b/, /\bpasame con\b/, /\bquiero hablar\b/,
];
export const wantsHuman = (text: string): boolean => { const t = normalize(text); return HUMAN.some((r) => r.test(t)); };

const AFFIRM = /^(si+|sii+|dale|ok|okey|oka|listo|joya|perfecto|confirmo|confirmar|confirmado|de acuerdo|adelante|buenisimo|genial)\b/;
/** An explicit, unambiguous yes. Short, starts with an affirmative word and contains no negation. */
export function isAffirmative(text: string): boolean {
  const t = normalize(text);
  return t.length > 0 && t.length <= 40 && AFFIRM.test(t) && !/\b(no|nunca|tampoco)\b/.test(t);
}
export const isNegative = (text: string): boolean => /^(no+|nop|mejor no|nunca|cancela|cancelar|dejalo|olvidalo)\b/.test(normalize(text));

/** RN-013: the model may not tell the patient something is booked unless the booking tool actually succeeded. */
const CONFIRMATION_CLAIM = [
  /quedo (el turno )?(confirmad|reservad|agendad)/,
  /\b(te|lo) (confirme|reserve|agende)\b/,
  /\b(turno|cita) (esta |ya esta |fue |ya fue )?(confirmad|reservad|agendad)/,
  /\btu turno (esta|fue|quedo) /,
  /\bya (esta|quedo) (agendad|reservad|confirmad)/,
  /reserva (confirmada|realizada)/,
  // first-person past + a booking noun, unless it is a question or condition ("que reserve", "si confirme")
  /(?<!que )(?<!si )(?<!para que )\b(agende|reserve|confirme|programe|registre|anote)\b.{0,30}\b(turno|cita|horario|consulta)\b/,
];
// Unaccented subjunctives look alike; the accented preterite ("reservé") is unambiguous.
const ACCENTED_PRETERITE = /(?<![\p{L}])(agendé|reservé|confirmé|programé|registré|anoté)(?![\p{L}])/iu;
export const claimsConfirmation = (text: string): boolean => ACCENTED_PRETERITE.test(text) || CONFIRMATION_CLAIM.some((r) => r.test(normalize(text)));

/** The assistant never sends links (phishing and payment-link abuse; real links are system-generated, P1). */
export const containsLink = (text: string): boolean => /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|ar|io|me|ly)\b\/)/i.test(text);

/** Data minimization toward the model provider: no phone numbers, e-mails or long digit sequences leave the platform (spec 13.4). */
export function redactForLlm(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[número]');
}

export const URGENCY_TEXT =
  'Si lo que te pasa es una urgencia (dolor intenso, sangrado, hinchazón que avanza, golpe fuerte o dificultad para respirar o tragar), no esperes: acudí a una guardia o llamá a los servicios de emergencia de tu zona. Ya avisé a recepción para que lean tu mensaje y te respondan en cuanto puedan.';
export const HANDOFF_TEXT = 'Te paso con recepción para que te ayuden. En cuanto puedan, te escriben por acá.';
export const ERROR_TEXT = 'Tuve un problema técnico para ayudarte. Te paso con recepción para que te escriban por acá.';
export const RELEASED_TEXT = 'Listo, no confirmé el turno y liberé el horario. ¿Querés que busque otras opciones?';
