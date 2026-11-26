import {
  isISO8601,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/** ISO 8601 с часовым поясом: `Z` или смещение `±HH:MM`. */
const ISO_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const MEETING_INSTANT_MESSAGE =
  'Дата должна быть в ISO 8601 с часовым поясом';

export function isMeetingInstant(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    ISO_WITH_TIMEZONE.test(value) &&
    isISO8601(value, { strict: true, strictSeparator: true })
  );
}

export function IsMeetingInstant(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isMeetingInstant',
      target: object.constructor,
      propertyName,
      options: {
        message: MEETING_INSTANT_MESSAGE,
        ...validationOptions,
      },
      validator: {
        validate: isMeetingInstant,
      },
    });
  };
}

/** Конец интервала строго позже начала. Пустые поля не сравнивает: их проверит другой валидатор. */
export function IsAfterInstant(property: string, message: string) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isAfterInstant',
      target: object.constructor,
      propertyName,
      constraints: [property],
      options: { message },
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const related = (args.object as Record<string, unknown>)[
            args.constraints[0] as string
          ];

          if (typeof value !== 'string' || typeof related !== 'string') {
            return true;
          }

          const start = Date.parse(related);
          const end = Date.parse(value);

          if (!Number.isFinite(start) || !Number.isFinite(end)) {
            return true;
          }

          return end > start;
        },
      },
    });
  };
}
