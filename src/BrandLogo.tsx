import logoUrl from './assets/qbsheet-black-logo.svg';

/** The QBSheet wordmark, with text retained for headings and assistive technology. */
export default function BrandLogo(props: { className?: string }) {
  return (
    <>
      <img className={props.className} src={logoUrl} alt="" aria-hidden="true" />
      <span className="visually-hidden">QBSheet</span>
    </>
  );
}
