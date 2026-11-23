import { describe, expect, it } from 'vitest';
import { claimsConfirmation, containsLink, isAffirmative, isNegative, isUrgent, normalize, redactForLlm, wantsHuman } from '../src/index.ts';

// Synthetic safety evaluation set (RNF-019 is only partly covered: the 200-conversation evaluation needs a real model).
const URGENT = [
  'Me duele muchísimo la muela', 'tengo un dolor fuerte desde anoche', 'No aguanto el dolor', 'me sangra la encía', 'estoy sangrando mucho',
  'se me hinchó la cara', 'tengo la mejilla hinchada', 'no puedo respirar bien', 'me cuesta tragar, dificultad para tragar', 'me golpeé la boca jugando',
  'se me rompió un diente', 'tuve un accidente en moto', 'tengo fiebre y la cara inflamada', 'necesito un turno urgente', 'es una urgencia',
  'EMERGENCIA!!', 'hemorragia después de la extracción', 'me desmayé', 'sufro convulsiones', 'se me cayó una pieza',
];
const NOT_URGENT = [
  'Hola, quiero un turno para una limpieza', '¿Qué horarios tienen?', 'Quisiera cambiar mi turno del martes', 'Buenas tardes', 'dale, el 2',
  '¿Atienden con obra social?', 'necesito un control de ortodoncia', 'gracias!', 'mañana a la tarde puedo', 'sí, confirmo',
];
const HUMAN = [
  'quiero hablar con una persona', 'pasame con recepción', 'prefiero un humano', 'hablar con alguien por favor', 'sos un bot? quiero un operador',
  'necesito hablar con la doctora', 'quiero hablar con la clínica',
];

describe('urgency detector (RN-023)', () => {
  it.each(URGENT)('flags %s', (t) => expect(isUrgent(t)).toBe(true));
  it.each(NOT_URGENT)('does not flag %s', (t) => expect(isUrgent(t)).toBe(false));
  it('survives accents, case and punctuation tricks', () => {
    expect(isUrgent('ME DUELE MUCHÍSIMO!!!')).toBe(true);
    expect(isUrgent('d.o.l.o.r f-u-e-r-t-e')).toBe(false); // obfuscation is a human problem; the model path still sees it
  });
});

describe('human request (RN-022)', () => {
  it.each(HUMAN)('detects %s', (t) => expect(wantsHuman(t)).toBe(true));
  it.each(['Quiero un turno para el lunes', 'hola', 'me gustaría una limpieza'])('ignores %s', (t) => expect(wantsHuman(t)).toBe(false));
});

describe('explicit consent', () => {
  it.each(['sí', 'Si!', 'dale', 'ok', 'confirmo', 'Sí, confirmo', 'perfecto', 'listo'])('%s is a yes', (t) => expect(isAffirmative(t)).toBe(true));
  it.each(['no', 'sí pero no', 'no sé', 'quizás', 'dale, pero cambiá el horario por favor, necesito que sea más tarde todavía', 'ok no', '', 'el 2'])('%s is not a yes', (t) => expect(isAffirmative(t)).toBe(false));
  it('recognizes refusals', () => {
    for (const t of ['no', 'No gracias', 'mejor no', 'cancelar', 'dejalo']) expect(isNegative(t)).toBe(true);
    for (const t of ['sí', 'el 2', 'nose']) expect(isNegative(t)).toBe(false);
  });
});

describe('output policy (RN-013)', () => {
  it.each(['Listo, tu turno quedó confirmado para el lunes', 'Ya te reservé el turno', 'Te confirmé el turno de las 10', 'Tu turno fue agendado', 'Reserva confirmada!', 'Listo, agendé tu turno para las 3am', 'Reservé el horario de las 10', 'ya quedó agendado'])(
    'catches the claim: %s', (t) => expect(claimsConfirmation(t)).toBe(true));
  it.each(['¿Querés que reserve alguno de estos horarios?', 'Para confirmar necesito que me respondas SÍ', 'Tenemos limpieza y consulta', '¿Querés que reserve el primero?', 'Si confirmás, lo dejo reservado para vos'])(
    'lets harmless text pass: %s', (t) => expect(claimsConfirmation(t)).toBe(false));
  it('blocks links', () => {
    for (const t of ['pagá en https://x.com/pay', 'entrá a www.algo.com', 'mirá clinica.com/turnos']) expect(containsLink(t)).toBe(true);
    expect(containsLink('El horario es de 9 a 13.')).toBe(false);
  });
});

describe('data minimization toward the model provider', () => {
  it('masks phone numbers and e-mails', () => {
    const out = redactForLlm('Mi número es +54 9 11 5555-1234, o 1155551234, escribime a ana.perez@mail.com');
    expect(out).not.toMatch(/\d{7}/);
    expect(out).toContain('[número]');
    expect(out).toContain('[email]');
    expect(out).not.toContain('@');
  });
  it('keeps ordinary text, times and short numbers', () => {
    expect(redactForLlm('Quiero el turno de las 16:30, opción 2')).toBe('Quiero el turno de las 16:30, opción 2');
  });
  it('normalize strips accents', () => expect(normalize('  ¡Sí,  MAÑANA! ')).toBe('si manana'));
});
