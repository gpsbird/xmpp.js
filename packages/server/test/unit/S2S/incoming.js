/* eslint-env mocha */

'use strict'

const IncomingServer = require('../../../lib/S2S/session/incoming')
const sinon = require('sinon')
const assert = require('assert')
const { Element } = require('ltx')
const tls = require('tls')

describe('S2S IncomingServer', () => {
  let server = null

  beforeEach(() => {
    server = new IncomingServer()
  })

  function assertStanza(spy, expectedStanza) {
    sinon.assert.calledWith(spy, sinon.match((stanza) => {
      return stanza.toString() === expectedStanza
    }))
  }

  describe('sendFeatures', () => {
    const streamFeaturesNoSASL = '<stream:features/>'
    const streamFeaturesSASL = '<stream:features><mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>EXTERNAL</mechanism></mechanisms></stream:features>'

    function assertFeatures(secureDomain, isSecure, isAuthed, expectedStanza) {
      const sendStub = sinon.stub(server, 'send')

      server.secureDomain = secureDomain
      server.isSecure = isSecure
      server.isAuthed = isAuthed

      server.sendFeatures()

      assertStanza(sendStub, expectedStanza)
    }

    it('should offer SASL EXTERNAL mechanism if connection is secured and secureDomain is true', () => {
      assertFeatures(true, true, undefined, streamFeaturesSASL)
    })

    it('should not offer SASL EXTERNAL mechanism if connection is not secured and secureDomain is true', () => {
      assertFeatures(true, undefined, undefined, streamFeaturesNoSASL)
    })

    it('should not offer SASL EXTERNAL mechanism if connection is secured and secureDomain is not set', () => {
      assertFeatures(undefined, true, undefined, streamFeaturesNoSASL)
    })
    it('should not offer SASL EXTERNAL mechanism if connection is secured and secureDomain is set and isAuthed', () => {
      assertFeatures(true, true, true, streamFeaturesNoSASL)
    })
  })

  describe('verifyCertificate', () => {
    class FakeSocket {
      // Good aproximation of the server identity check in TLS wrapper
      checkServerIdentity() {
        const cert = this.getPeerCertificate()
        const verifyError = tls.checkServerIdentity(this.servername, cert)

        if (verifyError) {
          this.authorized = false
          this.authorizationError = verifyError.code || verifyError.message
        } else {
          this.authorized = true
        }
      }

      getPeerCertificate() { throw new Error('Unimplemented Fake Socket Stub') }
    }

    it('should call unauthorized method if fails TLS authorization', () => {
      server.socket = {
        authorized: false,
        authorizationError: 'failed error',
        getPeerCertificate: sinon.stub(),
      }

      const sendNotAuthorizedStub = sinon.stub(server, 'sendNotAuthorizedAndClose')
      const emitStub = sinon.stub(server, 'emit')

      server.verifyCertificate()

      sinon.assert.calledOnce(sendNotAuthorizedStub)
      sinon.assert.notCalled(emitStub)
      sinon.assert.notCalled(server.socket.getPeerCertificate)
    })

    it('should call unauthorized method if fails certificate identity check', () => {
      server.socket = new FakeSocket()
      server.socket.servername = 'xmpp.example.com'

      sinon.stub(server.socket, 'getPeerCertificate').returns({
        subject: { CN: 'example.com' },
      })

      const sendNotAuthorizedStub = sinon.stub(server, 'sendNotAuthorizedAndClose')
      const emitStub = sinon.stub(server, 'emit')

      server.socket.checkServerIdentity()

      server.verifyCertificate()

      sinon.assert.calledOnce(sendNotAuthorizedStub)
      sinon.assert.notCalled(emitStub)
      sinon.assert.calledOnce(server.socket.getPeerCertificate)
    })

    it('should call unauthorized method if fails certificate identity check 2', () => {
      server.socket = new FakeSocket()
      server.socket.servername = 'example.com'
      sinon.stub(server.socket, 'getPeerCertificate').returns({
        subject: { CN: '*.example.com' },
      })

      const sendNotAuthorizedStub = sinon.stub(server, 'sendNotAuthorizedAndClose')
      const emitStub = sinon.stub(server, 'emit')

      server.socket.checkServerIdentity()
      server.verifyCertificate()

      sinon.assert.calledOnce(sendNotAuthorizedStub)
      sinon.assert.notCalled(emitStub)
      sinon.assert.calledOnce(server.socket.getPeerCertificate)
    })

    it('should emit auth if passes authorization and identity check', () => {
      server.socket = new FakeSocket()
      server.socket.servername = 'example.com'
      sinon.stub(server.socket, 'getPeerCertificate').returns({
        subjectaltname: 'DNS:example.com',
        subject: { CN: '*.example.com' },
      })

      const sendNotAuthorizedStub = sinon.stub(server, 'sendNotAuthorizedAndClose')
      const emitStub = sinon.stub(server, 'emit')

      server.socket.checkServerIdentity()
      server.verifyCertificate()

      sinon.assert.notCalled(sendNotAuthorizedStub)
      sinon.assert.calledWith(emitStub, 'auth', 'SASL')
      sinon.assert.calledOnce(server.socket.getPeerCertificate)
    })
  })

  describe('handleSASLExternal', () => {
    const validAuthElement = new Element('auth', {
      xmlns: IncomingServer.NS_XMPP_SASL,
      mechanism: 'EXTERNAL',
    })

    it('should not handle SASL EXTERNAL if not secure connection', () => {
      assert.equal(server.handleSASLExternal(validAuthElement), false)
    })

    it('should not handle SASL EXTERNAL if missing mechanism', () => {
      assert.equal(server.handleSASLExternal(new Element('auth', {
        xmlns: IncomingServer.NS_XMPP_SASL,
      })), false)
    })

    it('should not renegotiate for certificate if certificate contains data', () => {
      server.isSecure = true

      server.socket = {
        getPeerCertificate: sinon.stub().returns(
          {
            subject: {
              C: 'US',
              ST: 'NC',
              L: 'Raleigh',
              O: 'Example.com',
              CN: 'example.com',
            },
            issuer: {
              C: 'US',
              ST: 'NC',
              L: 'Durham',
              O: 'Realtime',
              CN: '*.nodexmpp.com',
            },
          }),
        renegotiate: sinon.stub().yields(null),
      }

      const verifyCertificateStub = sinon.stub(server, 'verifyCertificate')

      assert.equal(server.handleSASLExternal(validAuthElement), true)

      sinon.assert.notCalled(server.socket.renegotiate)
      sinon.assert.calledOnce(verifyCertificateStub)
    })

    it('should renegotiate for certificate if certificate is empty', () => {
      server.isSecure = true

      server.socket = {
        getPeerCertificate: sinon.stub().returns({}),
        renegotiate: sinon.stub().yields(null),
      }

      const verifyCertificateStub = sinon.stub(server, 'verifyCertificate')

      assert.equal(server.handleSASLExternal(validAuthElement), true)

      sinon.assert.calledWith(server.socket.renegotiate, { requestCert: true })
      assert(server.socket.renegotiate.calledBefore(verifyCertificateStub))
      sinon.assert.calledOnce(verifyCertificateStub)
    })

    it('should renegotiate for certificate if certificate is null', () => {
      server.isSecure = true

      server.socket = {
        getPeerCertificate: sinon.stub().returns(null),
        renegotiate: sinon.stub().yields(null),
      }

      const verifyCertificateStub = sinon.stub(server, 'verifyCertificate')

      assert.equal(server.handleSASLExternal(validAuthElement), true)

      sinon.assert.calledWith(server.socket.renegotiate, { requestCert: true })
      assert(server.socket.renegotiate.calledBefore(verifyCertificateStub))
      sinon.assert.calledOnce(verifyCertificateStub)
    })
  })

  it('should send <success> onSASLAuth call and start new stream', () => {
    const sendStub = sinon.stub(server, 'send')
    const streamStartStub = sinon.stub(server, 'streamStart')

    server.onSASLAuth()

    assertStanza(sendStub, '<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>')
    sinon.assert.calledOnce(streamStartStub)
    assert(sendStub.calledBefore(streamStartStub))
  })

  describe('handleTlsNegotiation', () => {
    it('should send <proceed> after seeing <starttls>', () => {
      const credentials = {}
      server.credentials = credentials

      const setSecureStub = sinon.stub(server, 'setSecure')
      const sendStub = sinon.stub(server, 'send')

      assert(server.handleTlsNegotiation(new Element('starttls', { xmlns: server.NS_XMPP_TLS })))

      assertStanza(sendStub, '<proceed xmlns="urn:ietf:params:xml:ns:xmpp-tls"/>')
      sinon.assert.calledWithExactly(setSecureStub, credentials, true, undefined)
    })
  })

  it('should send not authorized response and close stream', () => {
    const sendStub = sinon.stub(server, 'send')
    const closeStreamStub = sinon.stub(server, 'closeStream')
    const endStub = sinon.stub(server, 'end')

    server.sendNotAuthorizedAndClose()

    assertStanza(sendStub, '<failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><not-authorized/></failure>')
    sinon.assert.calledOnce(endStub)
    sinon.assert.calledOnce(closeStreamStub)
    assert(sendStub.calledBefore(closeStreamStub))
    assert(closeStreamStub.calledBefore(endStub))
  })

  it('should not sendFeatures immediately after connect', () => {
    const sendFeaturesSpy = sinon.spy(server, 'sendFeatures')
    const fakeSocket = {
      on: sinon.stub().returnsThis(),
      once: sinon.stub().returnsThis(),
      emit: sinon.stub().returnsThis(),
      end: sinon.stub(),
      setKeepAlive: sinon.stub(),
    }
    server.emit('connect', fakeSocket)
    sinon.assert.notCalled(sendFeaturesSpy)
  })
})
