export default function SelfHostingVsHostedPrivateCalendar() {
  return (
    <>
      <p>
        If you spend any time in privacy communities, you&apos;ll hear one piece
        of advice repeated like a mantra: self-host everything. Run your own
        email server. Run your own cloud. Run your own calendar. And honestly,
        we get it. The instinct is right. If you control the hardware, you
        control the data.
      </p>

      <p>
        But there&apos;s a gap between the ideal and what most people can
        actually sustain. Self-hosting a calendar is not like installing an app.
        It&apos;s more like adopting a pet that needs constant feeding. A pet
        that, if you forget about it for a few weeks, might leak your medical
        appointments to the internet.
      </p>

      <p>
        We built SilentSuite for people who want private calendar sync without
        becoming full-time sysadmins. But we also made it self-hostable, because
        we think you should have the choice. So let&apos;s talk honestly about
        both paths.
      </p>

      <h2>The self-hosting path</h2>

      <p>
        The most common self-hosted calendar setup is{' '}
        <a
          href="https://nextcloud.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Nextcloud
        </a>{' '}
        with its built-in CalDAV server. Other popular options include{' '}
        <a
          href="https://radicale.org/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Radicale
        </a>{' '}
        and{' '}
        <a
          href="https://sabre.io/baikal/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Baikal
        </a>
        . All of them work. All of them give you a CalDAV endpoint that syncs
        with standard calendar apps.
      </p>

      <p>Here&apos;s what you actually need to run one:</p>

      <ul>
        <li>A VPS or home server (and if it&apos;s at home, a static IP or dynamic DNS)</li>
        <li>Docker or bare-metal Linux administration skills</li>
        <li>SSL certificates (Let&apos;s Encrypt, renewed automatically if you set it up right)</li>
        <li>A reverse proxy like Nginx or Caddy</li>
        <li>Regular backups to a separate location</li>
        <li>Security updates. Not just for your calendar software, but the OS, the web server, PHP, the database</li>
        <li>Monitoring, so you know when something breaks at 2 AM</li>
      </ul>

      <p>
        This is a real commitment. Not a weekend project you set and forget. If
        you&apos;re already running a homelab and enjoy this kind of work, it
        slots right in. If you&apos;re not, you&apos;re signing up for
        ongoing maintenance that only you can do.
      </p>

      <h2>What self-hosting gives you</h2>

      <p>
        Full control. That&apos;s the short answer. You pick the hardware. You
        pick the data centre (or your closet). You decide which software version
        runs, when it updates, and who has access. There is no third party
        involved. Nobody can change the terms of service on you, raise prices,
        or shut down the product.
      </p>

      <p>
        For some people, this is enough reason on its own. We respect that.
        Self-hosting is a legitimate choice, and it&apos;s one we actively
        support by making our own server code open source.
      </p>

      <h2>What self-hosting doesn&apos;t give you</h2>

      <p>
        Here&apos;s the part that gets glossed over in most self-hosting
        advocacy: <strong>self-hosting does not automatically mean your data is
        encrypted.</strong>
      </p>

      <p>
        Nextcloud stores your calendar data in a database. In plaintext. Radicale
        stores it as .ics files on disk. Also plaintext. If someone compromises
        your VPS, they can read every event on your calendar. If your hosting
        provider images your disk, same thing. If you forget to renew your SSL
        cert and fall back to HTTP for a day, your calendar data travels across
        the internet unencrypted.
      </p>

      <p>
        Self-hosting means <em>you</em> are the security team. You handle
        intrusion detection, firewall rules, SSH hardening, software
        vulnerabilities. That&apos;s fine if you have the skills. But it&apos;s
        worth being clear-eyed about what you&apos;re taking on.
      </p>

      <blockquote>
        <p>
          Owning the server doesn&apos;t mean the data is safe. It means
          you&apos;re the one responsible for making it safe.
        </p>
      </blockquote>

      <h2>The hosted path with end-to-end encryption</h2>

      <p>
        There&apos;s another approach: use a hosted service, but one where the
        server literally cannot read your data. This is what end-to-end
        encryption (E2EE) gives you.
      </p>

      <p>
        With E2EE, your calendar events are encrypted on your device before they
        leave it. The server stores ciphertext. The server operator, whether
        that&apos;s us or anyone else, cannot decrypt it. They don&apos;t have
        the key. A breach of the server reveals nothing useful. A subpoena
        returns encrypted blobs.
      </p>

      <p>
        The trust model is fundamentally different from traditional hosting. You
        don&apos;t trust the server. You trust the math. The cryptography is what
        protects you, not a company&apos;s promise or a privacy policy.
      </p>

      <p>A few services take this approach for calendars:</p>

      <ul>
        <li>
          <strong>SilentSuite</strong> (that&apos;s us): E2EE calendar, contacts,
          and tasks sync using the{' '}
          <a
            href="https://www.etebase.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Etebase protocol
          </a>
          . Open source. Zero-knowledge encrypted.
        </li>
        <li>
          <strong>Proton Calendar:</strong> E2EE, bundled with Proton Mail.
          Closed ecosystem, but solid encryption.
        </li>
        <li>
          <strong>Tuta Calendar:</strong> E2EE, part of the Tuta email suite.
          Similar trade-offs to Proton.
        </li>
      </ul>

      <h2>The hybrid option</h2>

      <p>
        Here&apos;s where it gets interesting. SilentSuite is fully
        self-hostable. Our server is open source under AGPL-3.0, and you can run
        it on your own infrastructure.
      </p>

      <p>
        That means you can have both: E2EE <em>and</em> full control of the
        server. Your data is encrypted before it reaches the server, and the
        server is yours. Even if someone breaks into your VPS, they get
        ciphertext. Not your calendar.
      </p>

      <p>
        This is the best of both worlds for people who want it. But the key
        point is: <strong>you don&apos;t have to.</strong> The hosted version
        gives you the same encryption guarantees without any of the server
        maintenance. The self-hosted option exists for people who want the extra
        control, not because the hosted version is less secure.
      </p>

      <h2>Cost comparison</h2>

      <p>
        Let&apos;s talk money, because people often undercount the real cost of
        self-hosting.
      </p>

      <ul>
        <li>
          <strong>Self-hosted VPS:</strong> $5 to $10/month for a basic server
          (Hetzner, Contabo, DigitalOcean). Plus your time for setup, updates,
          backups, and troubleshooting. If you value your time at all, this adds
          up. A single evening debugging a broken Nextcloud update after a PHP
          version bump is worth more than a year of hosting fees.
        </li>
        <li>
          <strong>SilentSuite hosted:</strong> $4.99/month. We handle the
          server, the updates, the backups, the monitoring. You get E2EE sync
          that just works.
        </li>
        <li>
          <strong>Proton:</strong> Calendar is included with Proton paid plans,
          starting around $4/month. But you&apos;re buying the whole Proton
          ecosystem, which may or may not be what you need.
        </li>
      </ul>

      <p>
        The hidden cost of self-hosting is time. Not just the initial setup, but
        the ongoing obligation. Security patches don&apos;t apply themselves.
        Backups need testing. Certs need renewing. Disks fill up. Things break on
        holidays.
      </p>

      <h2>Who should self-host</h2>

      <p>Self-hosting makes sense if you:</p>

      <ul>
        <li>Genuinely enjoy running servers and treating infrastructure as a hobby</li>
        <li>Are a sysadmin by trade and this is just another service on your stack</li>
        <li>Have specific compliance requirements that mandate on-premises data storage</li>
        <li>Don&apos;t trust any third party with your data, even encrypted data</li>
        <li>Want to run SilentSuite&apos;s server yourself for the E2EE plus full-control combination</li>
      </ul>

      <p>
        If any of those describe you, great. We actively support self-hosting and
        our server documentation is written with you in mind.
      </p>

      <h2>Who should use hosted E2EE</h2>

      <p>Everyone else.</p>

      <p>
        Specifically: people who use Signal instead of running their own XMPP
        server. People who use Proton Mail instead of configuring Postfix. People
        who chose Bitwarden&apos;s hosted service instead of self-hosting
        Vaultwarden. The approach is the same. Pick a service with strong
        encryption, open-source code you can audit, and a sustainable business
        model. Then get on with your life.
      </p>

      <p>
        We sometimes call this the &ldquo;privacy middle class.&rdquo; Not
        apathetic about privacy, but not willing to make it a second job either.
        That&apos;s most people. And that&apos;s completely reasonable.
      </p>

      <p>
        Privacy shouldn&apos;t require a Linux certification. It should be the
        default. E2EE hosted services make that possible by shifting the security
        burden from the user to the protocol. You don&apos;t need to trust the
        server because the server never sees your data in the clear.
      </p>

      <h2>The bottom line</h2>

      <p>
        Both paths are valid. Self-hosting gives you control. Hosted E2EE gives
        you convenience with equivalent (and in some ways stronger) security
        guarantees. The worst option is the one most people are stuck on right
        now: syncing plaintext calendar data through Google or Apple, where the
        provider can read everything and you control nothing.
      </p>

      <p>
        We built SilentSuite for people who want privacy without a second job
        maintaining infrastructure. Calendar sync that&apos;s encrypted by
        design, hosted in the EU, open source, and simple to use. But we made
        the server self-hostable too, because we think the choice should always
        be yours.
      </p>

      <hr />

      <p>
        Ready to try private calendar sync?{' '}
        <a href="/#waitlist">Join the SilentSuite waitlist</a>. We&apos;ll send
        you one email when the beta opens. That&apos;s it.
      </p>
    </>
  )
}
