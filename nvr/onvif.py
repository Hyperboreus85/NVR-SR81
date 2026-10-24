"""Small, offline-capable ONVIF profile importer for a manually supplied endpoint.

This deliberately implements only the SOAP operations needed to obtain RTSP URIs.
It is not a full ONVIF client and does not perform WS-Discovery or fetch WSDLs.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timezone
from urllib.parse import quote, urljoin, urlsplit, urlunsplit
from uuid import uuid4
from xml.etree import ElementTree as ET

import httpx
from defusedxml import ElementTree as SafeET
from defusedxml.common import DefusedXmlException

SOAP = "http://www.w3.org/2003/05/soap-envelope"
DEVICE = "http://www.onvif.org/ver10/device/wsdl"
MEDIA1 = "http://www.onvif.org/ver10/media/wsdl"
MEDIA2 = "http://www.onvif.org/ver20/media/wsdl"
SCHEMA = "http://www.onvif.org/ver10/schema"
WSSE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
WSU = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
WSA = "http://www.w3.org/2005/08/addressing"
PASSWORD_DIGEST = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest"
BASE64_BINARY = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary"


class OnvifError(ValueError):
    """A safe, user-facing import failure; never contains credentials or SOAP data."""


def _tag(namespace: str, name: str) -> str:
    return f"{{{namespace}}}{name}"


def _child(parent: ET.Element, namespace: str, name: str, value: str | None = None) -> ET.Element:
    node = ET.SubElement(parent, _tag(namespace, name))
    node.text = value
    return node


def _text(parent: ET.Element, name: str) -> str:
    node = parent.find(f".//{{*}}{name}")
    return (node.text or "").strip() if node is not None else ""


def _url(value: str, schemes: tuple[str, ...], *, allow_credentials: bool = False):
    try:
        if not isinstance(value, str) or not value or any(c.isspace() or ord(c) < 32 for c in value):
            raise ValueError
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in schemes or not parsed.hostname or parsed.fragment:
            raise ValueError
        if not allow_credentials and (parsed.username is not None or parsed.password is not None):
            raise ValueError
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError
        return parsed
    except (ValueError, TypeError):
        raise OnvifError("Indirizzo ONVIF o URI RTSP non valido.") from None


def _replace_unspecified(value: str, camera_endpoint: str) -> str:
    parsed = urlsplit(value)
    if parsed.hostname not in ("0.0.0.0", "::"):
        return value
    host = urlsplit(camera_endpoint).hostname
    host = f"[{host}]" if ":" in host else host
    port = f":{parsed.port}" if parsed.port is not None else ""
    # Preserve any userinfo already supplied by the device, including escaping.
    userinfo = parsed.netloc.rsplit("@", 1)[0] + "@" if "@" in parsed.netloc else ""
    return urlunsplit(parsed._replace(netloc=f"{userinfo}{host}{port}"))


def _stream_url(value: str, camera_endpoint: str, username: str, password: str) -> str:
    parsed = _url(value, ("rtsp", "rtsps"), allow_credentials=True)
    value = _replace_unspecified(value, camera_endpoint)
    parsed = urlsplit(value)
    if parsed.username is None and username:
        userinfo = f"{quote(username, safe='')}:{quote(password, safe='')}@"
        value = urlunsplit(parsed._replace(netloc=userinfo + parsed.netloc))
    return value


def _envelope(namespace: str, operation: str, endpoint: str, username: str, password: str,
              arguments: list[tuple[str, str, str]] | None = None) -> bytes:
    root = ET.Element(_tag(SOAP, "Envelope"))
    header = _child(root, SOAP, "Header")
    _child(header, WSA, "Action", namespace + "/" + operation)
    _child(header, WSA, "To", endpoint)
    _child(header, WSA, "MessageID", "urn:uuid:" + str(uuid4()))
    if username:
        security = _child(header, WSSE, "Security")
        security.set(_tag(SOAP, "mustUnderstand"), "1")
        token = _child(security, WSSE, "UsernameToken")
        _child(token, WSSE, "Username", username)
        nonce = secrets.token_bytes(16)
        created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        digest = base64.b64encode(hashlib.sha1(nonce + created.encode() + password.encode()).digest()).decode()
        _child(token, WSSE, "Password", digest).set("Type", PASSWORD_DIGEST)
        _child(token, WSSE, "Nonce", base64.b64encode(nonce).decode()).set("EncodingType", BASE64_BINARY)
        _child(token, WSU, "Created", created)
    body = _child(root, SOAP, "Body")
    request = _child(body, namespace, operation)
    for arg_namespace, name, value in arguments or []:
        _child(request, arg_namespace, name, value)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


async def _soap(client: httpx.AsyncClient, endpoint: str, namespace: str, operation: str,
                username: str, password: str, arguments=None) -> ET.Element:
    content = _envelope(namespace, operation, endpoint, username, password, arguments)
    if operation == "GetStreamUri" and namespace == MEDIA1:
        root = ET.fromstring(content)
        request = root.find(f"{{{SOAP}}}Body/{{{MEDIA1}}}GetStreamUri")
        setup = ET.Element(_tag(MEDIA1, "StreamSetup"))
        _child(setup, SCHEMA, "Stream", "RTP-Unicast")
        transport = _child(setup, SCHEMA, "Transport")
        _child(transport, SCHEMA, "Protocol", "RTSP")
        request.insert(0, setup)
        content = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    try:
        async with client.stream("POST", endpoint, content=content, headers={
            "Content-Type": f'application/soap+xml; charset=utf-8; action="{namespace}/{operation}"',
            "SOAPAction": f'"{namespace}/{operation}"',
        }) as response:
            if response.status_code in (401, 403):
                raise OnvifError("Autenticazione ONVIF rifiutata: controllare utente, password e orologio della telecamera.")
            response.raise_for_status()
            xml = bytearray()
            async for chunk in response.aiter_bytes(65536):
                if len(xml) + len(chunk) > 2 * 1024 * 1024:
                    raise OnvifError("Risposta ONVIF troppo grande.")
                xml.extend(chunk)
        root = SafeET.fromstring(xml, forbid_dtd=True)
        if root.find(".//{*}Fault") is not None:
            raise OnvifError("Operazione ONVIF non disponibile o rifiutata dalla telecamera.")
        body = root.find(f"{{{SOAP}}}Body")
        # A few older devices respond using SOAP 1.1 envelopes.
        if body is None:
            body = root.find("{http://schemas.xmlsoap.org/soap/envelope/}Body")
        if body is None or body.find(f"{{*}}{operation}Response") is None:
            raise OnvifError("La telecamera ha restituito una risposta ONVIF inattesa.")
        return body
    except (httpx.HTTPError, ET.ParseError, DefusedXmlException):
        raise OnvifError("Connessione ONVIF fallita o risposta XML non valida.") from None


async def get_profiles(endpoint: str, username: str = "", password: str = "") -> dict:
    """Return importable RTSP profiles from a manual Device or Media endpoint.

    Prefer Media2 (needed by many H.265 cameras), fall back to Media1. Advertised
    service addresses are tried before using the supplied endpoint directly.
    HTTP Digest and WS-Security UsernameToken PasswordDigest are both supported.
    TLS verification remains enabled and HTTP redirects/proxy environment are off.
    """
    _url(endpoint, ("http", "https"))
    candidates: list[tuple[str, str]] = []
    last_error = OnvifError("Nessun profilo RTSP disponibile: verificare endpoint, credenziali e servizi ONVIF.")

    def add(namespace: str, address: str):
        if namespace not in (MEDIA1, MEDIA2) or not address:
            return
        try:
            address = _replace_unspecified(urljoin(endpoint, address), endpoint)
            _url(address, ("http", "https"))
            if (namespace, address) not in candidates:
                candidates.append((namespace, address))
        except OnvifError:
            pass

    auth = httpx.DigestAuth(username, password) if username else None
    async with httpx.AsyncClient(auth=auth, timeout=httpx.Timeout(8.0), follow_redirects=False,
                                 trust_env=False) as client:
        try:
            services = await _soap(client, endpoint, DEVICE, "GetServices", username, password,
                                   [(DEVICE, "IncludeCapability", "false")])
            for service in services.findall(".//{*}Service"):
                add(_text(service, "Namespace"), _text(service, "XAddr"))
        except OnvifError as error:
            last_error = error
        try:
            capabilities = await _soap(client, endpoint, DEVICE, "GetCapabilities", username, password,
                                       [(DEVICE, "Category", "Media")])
            for media in capabilities.findall(".//{*}Media"):
                add(MEDIA1, _text(media, "XAddr"))
        except OnvifError as error:
            last_error = error
        candidates.sort(key=lambda candidate: candidate[0] != MEDIA2)
        # This also supports entering a Media service URL instead of Device URL.
        add(MEDIA2, endpoint)
        add(MEDIA1, endpoint)
        for namespace, address in candidates:
            try:
                arguments = [(MEDIA2, "Type", "VideoEncoder")] if namespace == MEDIA2 else []
                result = await _soap(client, address, namespace, "GetProfiles", username, password, arguments)
                profiles = []
                for profile in result.findall(".//{*}Profiles"):
                    token = profile.get("token", "")
                    if not token:
                        continue
                    arguments = [(namespace, "ProfileToken", token)]
                    if namespace == MEDIA2:
                        arguments.insert(0, (namespace, "Protocol", "RTSP"))
                    try:
                        stream = await _soap(client, address, namespace, "GetStreamUri", username, password, arguments)
                        uri = _stream_url(_text(stream, "Uri"), endpoint, username, password)
                    except OnvifError as error:
                        last_error = error
                        continue
                    profiles.append({"token": token, "name": _text(profile, "Name") or token,
                                     "encoding": _text(profile, "Encoding") or "unknown", "url": uri})
                if profiles:
                    return {"profiles": profiles}
            except OnvifError as error:
                last_error = error
    raise last_error
