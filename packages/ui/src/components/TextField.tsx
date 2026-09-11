/**
 * A labelled text input.
 *
 * React Aria connects the label, the description and the error to the input programmatically, so
 * a screen reader reads "Relay URL, edit text, https://…workers.dev" rather than "edit text".
 * Doing that by hand means an `id`, an `htmlFor`, an `aria-describedby` and remembering all three
 * at every call site.
 */

import { FieldError, Input, Label, Text, TextField as AriaTextField } from 'react-aria-components';

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** `password` masks the value. Used for the relay's one-time setup token. */
  type?: 'text' | 'password';
  description?: string;
  errorMessage?: string;
  placeholder?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  autoComplete?: string;
  className?: string;
}

export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  description,
  errorMessage,
  placeholder,
  isRequired,
  isDisabled,
  autoComplete,
  className,
}: TextFieldProps) {
  return (
    <AriaTextField
      value={value}
      onChange={onChange}
      type={type}
      isRequired={isRequired}
      isDisabled={isDisabled}
      isInvalid={errorMessage !== undefined}
      className={['qbs-field', className].filter(Boolean).join(' ')}
    >
      <Label className="qbs-field__label">{label}</Label>
      <Input className="qbs-field__input" placeholder={placeholder} autoComplete={autoComplete} />
      {description ? (
        <Text slot="description" className="qbs-field__hint">
          {description}
        </Text>
      ) : null}
      <FieldError className="qbs-field__error">{errorMessage}</FieldError>
    </AriaTextField>
  );
}
