/**
 * Form validator for react-jsonschema-form that does NOT use eval / new Function.
 *
 * The default RJSF validator (Ajv) generates JavaScript at run time, which a strict
 * Content-Security-Policy (no 'unsafe-eval') blocks. This one uses the `jsonschema`
 * package, which interprets the schema instead. The server validates again with Ajv.
 */
import { Validator, type ValidationError as JsError } from 'jsonschema'
import {
  ROOT_SCHEMA_PREFIX,
  createErrorHandler,
  toErrorList,
  toErrorSchema,
  unwrapErrorHandler,
  validationDataMerge,
  withIdRefPrefix,
  type CustomValidator,
  type ErrorSchema,
  type ErrorTransformer,
  type FormContextType,
  type RJSFSchema,
  type RJSFValidationError,
  type StrictRJSFSchema,
  type UiSchema,
  type ValidationData,
  type ValidatorType,
} from '@rjsf/utils'

const MESSAGES: Record<string, (a: unknown) => string> = {
  required: (a) => `must have required property '${a}'`,
  enum: () => 'must be equal to one of the allowed values',
  format: (a) => `must match format "${a}"`,
  type: (a) => `must be ${Array.isArray(a) ? a.join(',') : a}`,
  minimum: (a) => `must be >= ${a}`,
  maximum: (a) => `must be <= ${a}`,
  minLength: (a) => `must NOT have fewer than ${a} characters`,
  maxLength: (a) => `must NOT have more than ${a} characters`,
  pattern: (a) => `must match pattern "${a}"`,
  minItems: (a) => `must NOT have fewer than ${a} items`,
  maxItems: (a) => `must NOT have more than ${a} items`,
}

function toRjsfErrors(errors: JsError[]): RJSFValidationError[] {
  return errors.map((e) => {
    const base = e.path.map(String)
    const name = e.name
    const missing = name === 'required' ? String(e.argument) : undefined
    const segments = missing ? [...base, missing] : base
    const property = segments.length ? `.${segments.join('.')}` : '.'
    const message = MESSAGES[name]?.(e.argument) ?? e.message
    const params: Record<string, unknown> =
      name === 'required'
        ? { missingProperty: missing }
        : name === 'enum'
          ? { allowedValues: e.argument }
          : name === 'format'
            ? { format: e.argument }
            : { limit: e.argument }
    return { name, property, message, params, stack: `${property} ${message}`.trim(), schemaPath: '' }
  })
}

export class CspSafeValidator<T = unknown, S extends StrictRJSFSchema = RJSFSchema, F extends FormContextType = FormContextType>
  implements ValidatorType<T, S, F>
{
  private rootValidator: { root: unknown; v: Validator } | null = null

  private validatorFor(rootSchema?: S): Validator {
    if (!rootSchema) return new Validator()
    if (this.rootValidator?.root !== rootSchema) {
      const v = new Validator()
      v.addSchema({ ...(rootSchema as object), $id: ROOT_SCHEMA_PREFIX } as never, ROOT_SCHEMA_PREFIX)
      this.rootValidator = { root: rootSchema, v }
    }
    return this.rootValidator.v
  }

  rawValidation<Result = unknown>(schema: S, formData?: T): { errors?: Result[]; validationError?: Error } {
    try {
      const res = new Validator().validate(formData ?? {}, schema as never, { allowUnknownAttributes: true })
      return { errors: res.errors as unknown as Result[] }
    } catch (e) {
      return { validationError: e as Error }
    }
  }

  validateFormData(
    formData: T | undefined,
    schema: S,
    customValidate?: CustomValidator<T, S, F>,
    transformErrors?: ErrorTransformer<T, S, F>,
    uiSchema?: UiSchema<T, S, F>,
  ): ValidationData<T> {
    const raw = this.rawValidation<JsError>(schema, formData)
    let errors = raw.validationError
      ? [{ name: 'schema', property: '.', message: raw.validationError.message, stack: raw.validationError.message }]
      : toRjsfErrors(raw.errors ?? [])
    if (typeof transformErrors === 'function') errors = transformErrors(errors, uiSchema)

    let errorSchema = toErrorSchema<T>(errors)
    if (typeof customValidate === 'function') {
      const handler = customValidate(formData, createErrorHandler<T>(formData as T), uiSchema)
      const userErrorSchema = unwrapErrorHandler<T>(handler)
      return validationDataMerge<T>({ errors, errorSchema }, userErrorSchema)
    }
    errorSchema = errorSchema as ErrorSchema<T>
    return { errors, errorSchema }
  }

  toErrorList(errorSchema?: ErrorSchema<T>, fieldPath: string[] = []) {
    return toErrorList<T>(errorSchema, fieldPath)
  }

  isValid(schema: S, formData: T | undefined, rootSchema: S): boolean {
    try {
      const v = this.validatorFor(rootSchema)
      return v.validate(formData ?? {}, withIdRefPrefix(schema) as never, { allowUnknownAttributes: true }).valid
    } catch {
      return false
    }
  }

  reset() {
    this.rootValidator = null
  }
}

export const validator = new CspSafeValidator()
