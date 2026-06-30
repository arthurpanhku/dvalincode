type Props = {
  className?: string;
  alt?: string;
};

export function ThemeLogo({ className = '', alt = 'DvalinCode' }: Props) {
  return (
    <span className={`theme-logo ${className}`} role="img" aria-label={alt}>
      <img src="/app-icon-dark.svg" alt="" aria-hidden="true" className="theme-logo-img theme-logo-dark" />
      <img src="/app-icon-light.svg" alt="" aria-hidden="true" className="theme-logo-img theme-logo-light" />
    </span>
  );
}
