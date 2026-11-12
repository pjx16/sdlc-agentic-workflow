FROM ubuntu/squid:6.6-24.04_beta@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029
COPY squid.conf /etc/squid/squid.conf
COPY entrypoint.sh /usr/local/bin/sdlc-proxy-entrypoint.sh
RUN chmod +x /usr/local/bin/sdlc-proxy-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/sdlc-proxy-entrypoint.sh"]
CMD ["-f", "/etc/squid/squid.conf", "-NYC"]
